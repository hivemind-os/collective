import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  ensureDaemonRunning,
  getDefaultIpcPath,
  getDefaultPidFile,
  resolveDaemonBin,
  type LauncherOptions,
} from './daemon-launcher.js';
import { IpcClient } from './ipc-client.js';

const execFileAsync = promisify(execFile);

export interface BridgeOptions {
  ipcPath?: string;
  pidFile?: string;
  daemonBin?: string;
  startupTimeoutMs?: number;
  appName?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => void;
  ensureDaemon?: (options: LauncherOptions) => Promise<void>;
}

export interface BridgeHandle {
  close(): void;
}

export async function startShim(): Promise<void> {
  await createBridge();
}

export async function createBridge(options: BridgeOptions = {}): Promise<BridgeHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const ensureDaemon = options.ensureDaemon ?? ensureDaemonRunning;
  const launcherOptions: LauncherOptions = {
    ipcPath: options.ipcPath ?? getDefaultIpcPath(),
    pidFile: options.pidFile ?? getDefaultPidFile(),
    daemonBin: options.daemonBin ?? resolveDaemonBin(),
    startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
  };
  const appName = options.appName ?? (await guessAppName());

  let client: IpcClient | undefined;
  let stdinBuffer = '';
  let closing = false;
  let reconnecting: Promise<void> | undefined;
  const pending: string[] = [];

  const writeError = (message: string) => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } })}\n`);
    stderr.write(`mesh-shim: ${message}\n`);
  };

  const flushPending = () => {
    if (!client) {
      return;
    }

    while (pending.length > 0) {
      try {
        client.sendRaw(pending[0] as string);
        pending.shift();
      } catch {
        return;
      }
    }
  };

  const connect = async () => {
    await ensureDaemon(launcherOptions);
    const deadline = Date.now() + launcherOptions.startupTimeoutMs;
    while (true) {
      const next = new IpcClient(launcherOptions.ipcPath);
      next.onMessage((message) => {
        stdout.write(`${JSON.stringify(message)}\n`);
      });
      next.onClose(() => {
        if (!closing && client === next) {
          client = undefined;
          void reconnect();
        }
      });

      try {
        await next.connect(appName);
        client = next;
        flushPending();
        return;
      } catch (error) {
        next.close();
        if (Date.now() >= deadline) {
          throw error;
        }
        await delay(200);
      }
    }
  };

  const reconnect = async () => {
    if (reconnecting) {
      return reconnecting;
    }

    reconnecting = (async () => {
      try {
        await connect();
      } catch (error) {
        if (!closing) {
          closing = true;
          client?.close();
          writeError(`Unable to reach mesh daemon: ${(error as Error).message}`);
          exit(1);
        }
      } finally {
        reconnecting = undefined;
      }
    })();

    return reconnecting;
  };

  try {
    await connect();
  } catch (error) {
    closing = true;
    writeError(`Unable to start mesh daemon: ${(error as Error).message}`);
    exit(1);
    return { close: () => undefined };
  }

  if ('setEncoding' in stdin && typeof stdin.setEncoding === 'function') {
    stdin.setEncoding('utf8');
  }

  const handleChunk = (chunk: string | Buffer) => {
    stdinBuffer += chunk.toString();
    let newlineIndex = stdinBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      if (line) {
        if (client) {
          try {
            client.sendRaw(line);
          } catch {
            pending.push(line);
            void reconnect();
          }
        } else {
          pending.push(line);
          void reconnect();
        }
      }
      newlineIndex = stdinBuffer.indexOf('\n');
    }
  };

  const shutdown = () => {
    if (closing) {
      return;
    }

    closing = true;
    stdin.off('data', handleChunk);
    stdin.off('end', shutdown);
    stdin.off('close', shutdown);
    client?.close();
    exit(0);
  };

  stdin.on('data', handleChunk);
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  if ('resume' in stdin && typeof stdin.resume === 'function') {
    stdin.resume();
  }

  return { close: shutdown };
}

async function guessAppName(): Promise<string> {
  if (process.env.COLLECTIVE_APP_NAME) {
    return process.env.COLLECTIVE_APP_NAME;
  }

  const arg = process.argv
    .map((value) => basename(value).toLowerCase())
    .find((value) => value && !['node', 'node.exe', 'mesh-shim', 'index.js'].includes(value));
  if (arg) {
    return arg.replace(/\.(cmd|exe)$/i, '');
  }

  try {
    const result =
      process.platform === 'win32'
        ? await execFileAsync(
            'powershell',
            ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${process.ppid}").Name`],
            { windowsHide: true },
          )
        : await execFileAsync('ps', ['-o', 'comm=', '-p', String(process.ppid)]);
    const name = basename(result.stdout.trim()).replace(/\.(cmd|exe)$/i, '').toLowerCase();
    return name || 'unknown';
  } catch {
    return 'unknown';
  }
}
