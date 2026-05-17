import { spawn, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadMeshConfig } from './config.js';
import { getDaemonStatus, type DaemonStatus } from '../utils/daemon-client.js';
import { error, info, success, table, warn } from '../utils/output.js';

const require = createRequire(import.meta.url);

export interface DaemonCommandDeps {
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => { pid?: number; unref: () => void };
  resolveDaemonCommand: () => Promise<{ command: string; args: string[] }>;
  getStatus: (ipcPath: string) => Promise<DaemonStatus>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  isProcessRunning: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: DaemonCommandDeps = {
  spawnProcess: (command, args, options) => spawn(command, args, options),
  resolveDaemonCommand,
  getStatus: getDaemonStatus,
  killProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
  isProcessRunning,
  sleep: (ms) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  }),
};

export async function handleDaemon(
  subcommand?: string,
  args: string[] = [],
  deps: DaemonCommandDeps = defaultDeps,
): Promise<number> {
  void args;
  switch (subcommand) {
    case 'start':
      return await startDaemon(deps);
    case 'stop':
      return await stopDaemon(deps);
    case 'status':
      return await statusDaemon(deps);
    default:
      throw new Error('Usage: mesh daemon <start|stop|status>');
  }
}

async function startDaemon(deps: DaemonCommandDeps): Promise<number> {
  const config = loadMeshConfig();
  const pid = readPid(config.daemon.pidFile);
  if (pid && deps.isProcessRunning(pid)) {
    info('Daemon is already running.');
    return await statusDaemon(deps);
  }

  if (pid && !deps.isProcessRunning(pid)) {
    rmSync(config.daemon.pidFile, { force: true });
  }

  const daemonCommand = await deps.resolveDaemonCommand();
  const child = deps.spawnProcess(daemonCommand.command, daemonCommand.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const ready = await waitForReady(config.daemon.ipcPath, deps);
  if (!ready) {
    error('Daemon did not become ready in time.');
    return 1;
  }

  success(`Daemon started${child.pid ? ` (pid ${child.pid})` : ''}.`);
  const status = await deps.getStatus(config.daemon.ipcPath);
  printStatus(status);
  return 0;
}

async function stopDaemon(deps: DaemonCommandDeps): Promise<number> {
  const config = loadMeshConfig();
  const pid = readPid(config.daemon.pidFile);
  if (!pid) {
    info('Daemon is not running.');
    return 1;
  }

  if (!deps.isProcessRunning(pid)) {
    rmSync(config.daemon.pidFile, { force: true });
    info('Daemon is not running.');
    return 1;
  }

  deps.killProcess(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await deps.sleep(100);
    if (!deps.isProcessRunning(pid)) {
      rmSync(config.daemon.pidFile, { force: true });
      success('Daemon stopped.');
      return 0;
    }
  }

  deps.killProcess(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await deps.sleep(100);
    if (!deps.isProcessRunning(pid)) {
      rmSync(config.daemon.pidFile, { force: true });
      success('Daemon stopped.');
      return 0;
    }
  }

  error('Unable to stop the daemon process.');
  return 1;
}

async function statusDaemon(deps: DaemonCommandDeps): Promise<number> {
  const config = loadMeshConfig();
  const pid = readPid(config.daemon.pidFile);
  if (!pid || !deps.isProcessRunning(pid)) {
    if (pid && !deps.isProcessRunning(pid)) {
      rmSync(config.daemon.pidFile, { force: true });
    }
    info('Daemon is not running.');
    return 1;
  }

  try {
    const status = await deps.getStatus(config.daemon.ipcPath);
    success('Daemon is running.');
    printStatus(status);
    return 0;
  } catch (caught) {
    warn('Daemon process exists, but IPC status could not be fetched.');
    console.log(`PID: ${pid}`);
    console.log(`PID file: ${config.daemon.pidFile}`);
    console.log(`Reason: ${caught instanceof Error ? caught.message : String(caught)}`);
    return 1;
  }
}

async function waitForReady(ipcPath: string, deps: DaemonCommandDeps): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await deps.getStatus(ipcPath);
      return true;
    } catch {
      await deps.sleep(100);
    }
  }

  return false;
}

function printStatus(status: DaemonStatus): void {
  if (status.version) {
    console.log(`Version: ${status.version}`);
  }
  console.log(`DID: ${status.did}`);
  console.log(`Address: ${status.address}`);
  console.log(`Uptime: ${formatDuration(status.uptimeMs ?? status.uptime ?? 0)}`);
  console.log(`Connected Apps: ${status.connectedApps.length}`);
  if (status.connectedApps.length > 0) {
    table(
      ['App', 'PID', 'Profile', 'Connected'],
      status.connectedApps.map((app) => [
        app.appName ?? '-',
        app.pid?.toString() ?? '-',
        app.profile ?? '-',
        new Date(app.connectedAt).toISOString(),
      ]),
    );
  }
}

async function resolveDaemonCommand(): Promise<{ command: string; args: string[] }> {
  try {
    const packageJsonPath = require.resolve('@hivemind-os/collective-daemon/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { main?: string };
    const entryPath = resolve(dirname(packageJsonPath), packageJson.main ?? 'dist/index.js');
    return {
      command: process.execPath,
      args: [entryPath],
    };
  } catch {
    const fallback = resolve(process.cwd(), 'packages', 'daemon', 'dist', 'index.js');
    if (existsSync(fallback)) {
      return {
        command: process.execPath,
        args: [fallback],
      };
    }

    throw new Error('Unable to locate @hivemind-os/collective-daemon. Run pnpm install && pnpm run build first.');
  }
}

function readPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) {
    return undefined;
  }

  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
