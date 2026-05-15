import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export interface LauncherOptions {
  ipcPath: string;
  pidFile: string;
  daemonBin: string;
  startupTimeoutMs: number;
}

export function getDefaultIpcPath(): string {
  return process.env.MESH_IPC_PATH ??
    (process.platform === 'win32'
      ? '\\\\.\\pipe\\agentic-mesh'
      : resolve(homedir(), '.agentic-mesh', 'mesh.sock'));
}

export function getDefaultPidFile(): string {
  return process.env.MESH_PID_FILE ?? resolve(homedir(), '.agentic-mesh', 'daemon.pid');
}

export function resolveDaemonBin(): string {
  if (process.env.MESH_DAEMON_BIN) {
    return process.env.MESH_DAEMON_BIN;
  }

  try {
    return require.resolve('@agentic-mesh/daemon');
  } catch {
    if (commandExists('mesh-daemon')) {
      return 'mesh-daemon';
    }

    return fileURLToPath(new URL('../../daemon/dist/index.js', import.meta.url));
  }
}

export async function isDaemonRunning(ipcPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect(ipcPath);
    const finish = (running: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(running);
    };

    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

export async function ensureDaemonRunning(options: LauncherOptions): Promise<void> {
  if (await isDaemonRunning(options.ipcPath)) {
    return;
  }

  const command = options.daemonBin.endsWith('.js') ? process.execPath : options.daemonBin;
  const args = options.daemonBin.endsWith('.js') ? [options.daemonBin] : [];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + options.startupTimeoutMs;
  while (Date.now() < deadline) {
    await delay(200);
    if (await isDaemonRunning(options.ipcPath)) {
      return;
    }
  }

  throw new Error(`Timed out waiting for daemon IPC at ${options.ipcPath} (pid file: ${options.pidFile})`);
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}
