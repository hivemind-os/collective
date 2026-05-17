import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, userInfo } from 'node:os';
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

const LEGACY_WINDOWS_PIPE_PATH = '\\\\.\\pipe\\hivemind-collective';

export function getDefaultIpcPath(): string {
  return process.env.COLLECTIVE_IPC_PATH ??
    (process.platform === 'win32'
      ? `${LEGACY_WINDOWS_PIPE_PATH}-${sanitizePipeSegment(getCurrentUsername())}`
      : resolve(homedir(), '.hivemind-os/collective', 'mesh.sock'));
}

export function getDefaultPidFile(): string {
  return process.env.COLLECTIVE_PID_FILE ?? resolve(homedir(), '.hivemind-os/collective', 'daemon.pid');
}

export function resolveDaemonBin(): string {
  if (process.env.COLLECTIVE_DAEMON_BIN) {
    return process.env.COLLECTIVE_DAEMON_BIN;
  }

  try {
    return require.resolve('@hivemind-os/collective-daemon');
  } catch {
    if (commandExists('collective-daemon')) {
      return 'collective-daemon';
    }

    // Monorepo fallback (only works when running from packages/shim/)
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
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrOutput = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrOutput += chunk;
  });
  child.unref();
  child.stderr?.unref();

  let exited = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + options.startupTimeoutMs;
  while (Date.now() < deadline) {
    await delay(200);
    if (await isDaemonRunning(options.ipcPath)) {
      return;
    }
    if (exited) {
      const detail = stderrOutput.trim() ? `\n${stderrOutput.trim()}` : '';
      throw new Error(`Daemon process exited with code ${exitCode} before IPC was ready.${detail}`);
    }
  }

  throw new Error(`Timed out waiting for daemon IPC at ${options.ipcPath} (pid file: ${options.pidFile})`);
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

function getCurrentUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown-user';
  }
}

function sanitizePipeSegment(value: string): string {
  const leaf = value.split(/[\\/]+/).filter(Boolean).at(-1) ?? value;
  const sanitized = leaf.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'unknown-user';
}
