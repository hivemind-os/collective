import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBridge } from '../src/bridge.js';

const createdPaths: string[] = [];
const servers = new Set<net.Server>();
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of [...sockets]) {
    socket.destroy();
  }

  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => {
            resolvePromise();
          });
        }),
    ),
  );
  servers.clear();
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class NdjsonReader {
  private buffer = '';
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];

  constructor(stream: NodeJS.ReadableStream) {
    if ('setEncoding' in stream && typeof stream.setEncoding === 'function') {
      stream.setEncoding('utf8');
    }

    stream.on('data', (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });
  }

  async nextMessage(): Promise<any> {
    if (this.messages.length > 0) {
      return this.messages.shift();
    }

    return new Promise((resolvePromise) => {
      this.waiters.push(resolvePromise);
    });
  }

  collected(): unknown[] {
    return [...this.messages];
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line) as unknown;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          this.messages.push(message);
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }
}

class NdjsonLineReader {
  private collected: string[] = [];

  constructor(stream: NodeJS.ReadableStream) {
    if ('setEncoding' in stream && typeof stream.setEncoding === 'function') {
      stream.setEncoding('utf8');
    }
    stream.on('data', (chunk: string | Buffer) => {
      this.collected.push(chunk.toString());
    });
  }

  lines(): string[] {
    return [...this.collected];
  }
}

class MockIpcServer {
  private server?: net.Server;
  private socket?: net.Socket;
  private reader?: NdjsonReader;

  constructor(private readonly ipcPath: string) {}

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      this.socket = socket;
      this.reader = new NdjsonReader(socket);
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        if (this.socket === socket) {
          this.socket = undefined;
          this.reader = undefined;
        }
      });
    });

    servers.add(this.server);
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.ipcPath, () => {
        this.server?.off('error', reject);
        resolvePromise();
      });
    });
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    servers.delete(server);
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
  }

  async nextMessage(): Promise<any> {
    while (!this.reader) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    return this.reader.nextMessage();
  }

  send(message: object): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }
}

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createIpcPath(dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\hivemind-collective-shim-${randomUUID()}`;
  }
  // Unix socket paths have a 108-char limit; use /tmp with a short name
  const short = randomUUID().slice(0, 8);
  return `/tmp/hm-shim-${short}.sock`;
}

describe('bridge', () => {
  it('sends shim_hello and bridges stdin/stdout messages', async () => {
    const dir = await createTestDir();
    const ipcPath = createIpcPath(dir);
    const server = new MockIpcServer(ipcPath);
    await server.start();

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = new NdjsonReader(stdout);
    const exit = vi.fn();

    const { SHIM_VERSION: shimVersion } = await import('../src/daemon-launcher.js');

    const bridgePromise = createBridge({
      ipcPath,
      pidFile: resolve(dir, 'daemon.pid'),
      daemonBin: 'mesh-daemon',
      appName: 'claude-desktop',
      stdin,
      stdout,
      stderr,
      exit,
      ensureDaemon: async () => undefined,
    });

    const hello = await server.nextMessage();
    expect(hello).toMatchObject({
      jsonrpc: '2.0',
      method: 'shim_hello',
      params: {
        appName: 'claude-desktop',
        pid: process.pid,
      },
    });

    server.send({
      jsonrpc: '2.0',
      id: hello.id,
      result: { acknowledged: true, connectionId: 'test-connection', daemonVersion: shimVersion },
    });
    const bridge = await bridgePromise;

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(output.collected()).toEqual([]);

    stdin.write('{"jsonrpc":"2.0","id":"ping","method":"ping"}\n');
    const forwarded = await server.nextMessage();
    expect(forwarded).toEqual({ jsonrpc: '2.0', id: 'ping', method: 'ping' });

    server.send({ jsonrpc: '2.0', id: 'pong', result: { ok: true } });
    await expect(output.nextMessage()).resolves.toEqual({ jsonrpc: '2.0', id: 'pong', result: { ok: true } });

    bridge.close();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reconnects and sends shim_hello again after the IPC connection drops', async () => {
    const dir = await createTestDir();
    const ipcPath = createIpcPath(dir);
    const firstServer = new MockIpcServer(ipcPath);
    await firstServer.start();

    let releaseReconnect = () => undefined;
    const reconnectGate = new Promise<void>((resolvePromise) => {
      releaseReconnect = resolvePromise;
    });
    const ensureDaemon = vi.fn(async () => {
      if (ensureDaemon.mock.calls.length > 1) {
        await reconnectGate;
      }
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exit = vi.fn();

    const { SHIM_VERSION: shimVersion } = await import('../src/daemon-launcher.js');

    const bridgePromise = createBridge({
      ipcPath,
      pidFile: resolve(dir, 'daemon.pid'),
      daemonBin: 'mesh-daemon',
      appName: 'vscode',
      stdin,
      stdout,
      stderr,
      exit,
      ensureDaemon,
      startupTimeoutMs: 1_000,
    });

    const firstHello = await firstServer.nextMessage();
    firstServer.send({
      jsonrpc: '2.0',
      id: firstHello.id,
      result: { acknowledged: true, connectionId: 'first', daemonVersion: shimVersion },
    });
    const bridge = await bridgePromise;

    await firstServer.stop();

    const secondServer = new MockIpcServer(ipcPath);
    await secondServer.start();
    releaseReconnect();

    const secondHello = await secondServer.nextMessage();
    expect(secondHello).toMatchObject({
      jsonrpc: '2.0',
      method: 'shim_hello',
      params: { appName: 'vscode', pid: process.pid },
    });

    secondServer.send({
      jsonrpc: '2.0',
      id: secondHello.id,
      result: { acknowledged: true, connectionId: 'second', daemonVersion: shimVersion },
    });

    stdin.write('{"jsonrpc":"2.0","id":"after-reconnect","method":"ping"}\n');
    await expect(secondServer.nextMessage()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 'after-reconnect',
      method: 'ping',
    });

    bridge.close();
    expect(exit).toHaveBeenCalledWith(0);
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
  });

  it('restarts daemon when version mismatch is detected', async () => {
    const dir = await createTestDir();
    const ipcPath = createIpcPath(dir);
    const pidFile = resolve(dir, 'daemon.pid');

    // Phase 1: old daemon with mismatched version
    let oldServer = new MockIpcServer(ipcPath);
    await oldServer.start();

    const stopDaemonMock = vi.fn(async () => {
      // Simulate stopDaemon: tear down the old server
      await oldServer.stop();
    });

    // Track ensureDaemon calls — on the 2nd call (after upgrade), start the "new" daemon
    let newServer: MockIpcServer | undefined;
    let newServerReady: () => void;
    const newServerPromise = new Promise<void>((r) => { newServerReady = r; });
    const ensureDaemon = vi.fn(async () => {
      if (ensureDaemon.mock.calls.length > 1) {
        // Start the "new" daemon after stopDaemon cleaned up the old one
        newServer = new MockIpcServer(ipcPath);
        await newServer.start();
        newServerReady();
      }
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrReader = new NdjsonLineReader(stderr);
    const exit = vi.fn();

    const { SHIM_VERSION: shimVersion } = await import('../src/daemon-launcher.js');

    const bridgePromise = createBridge({
      ipcPath,
      pidFile,
      daemonBin: 'mesh-daemon',
      appName: 'claude-desktop',
      stdin,
      stdout,
      stderr,
      exit,
      ensureDaemon,
      stopDaemon: stopDaemonMock,
      startupTimeoutMs: 5_000,
    });

    // Old daemon receives hello, responds with OLD version
    const oldHello = await oldServer.nextMessage();
    expect(oldHello).toMatchObject({ method: 'shim_hello' });
    oldServer.send({
      jsonrpc: '2.0',
      id: oldHello.id,
      result: { acknowledged: true, connectionId: 'old', daemonVersion: '0.0.1' },
    });

    // After mismatch, shim should call stopDaemon and ensureDaemon again
    // Wait for the new server to be ready
    await newServerPromise;
    // New daemon receives hello, responds with CURRENT version
    const newHello = await newServer!.nextMessage();
    expect(newHello).toMatchObject({ method: 'shim_hello' });
    newServer!.send({
      jsonrpc: '2.0',
      id: newHello.id,
      result: { acknowledged: true, connectionId: 'new', daemonVersion: shimVersion },
    });

    const bridge = await bridgePromise;

    // Verify the bridge works after upgrade
    stdin.write('{"jsonrpc":"2.0","id":"test","method":"ping"}\n');
    const forwarded = await newServer!.nextMessage();
    expect(forwarded).toEqual({ jsonrpc: '2.0', id: 'test', method: 'ping' });

    // Verify stopDaemon was called
    expect(stopDaemonMock).toHaveBeenCalledTimes(1);
    // ensureDaemon called twice: initial + after upgrade
    expect(ensureDaemon).toHaveBeenCalledTimes(2);

    // Verify stderr logged the upgrade
    const stderrOutput = stderrReader.lines().join('');
    expect(stderrOutput).toContain('Upgrading daemon from v0.0.1');
    expect(stderrOutput).toContain(shimVersion);

    bridge.close();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('accepts matching daemon version without restart', async () => {
    const dir = await createTestDir();
    const ipcPath = createIpcPath(dir);

    const server = new MockIpcServer(ipcPath);
    await server.start();

    const stopDaemonMock = vi.fn();
    const ensureDaemon = vi.fn(async () => undefined);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exit = vi.fn();

    const { SHIM_VERSION: shimVersion } = await import('../src/daemon-launcher.js');

    const bridgePromise = createBridge({
      ipcPath,
      pidFile: resolve(dir, 'daemon.pid'),
      daemonBin: 'mesh-daemon',
      appName: 'claude-desktop',
      stdin,
      stdout,
      stderr,
      exit,
      ensureDaemon,
      stopDaemon: stopDaemonMock,
    });

    const hello = await server.nextMessage();
    server.send({
      jsonrpc: '2.0',
      id: hello.id,
      result: { acknowledged: true, connectionId: 'ok', daemonVersion: shimVersion },
    });

    const bridge = await bridgePromise;

    // Should NOT have called stopDaemon
    expect(stopDaemonMock).not.toHaveBeenCalled();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);

    bridge.close();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('upgrades legacy daemons that do not report daemonVersion', async () => {
    const dir = await createTestDir();
    const ipcPath = createIpcPath(dir);

    let oldServer = new MockIpcServer(ipcPath);
    await oldServer.start();

    const stopDaemonMock = vi.fn(async () => {
      await oldServer.stop();
    });

    let newServer: MockIpcServer | undefined;
    let newServerReady: () => void;
    const newServerPromise = new Promise<void>((r) => { newServerReady = r; });
    const ensureDaemon = vi.fn(async () => {
      if (ensureDaemon.mock.calls.length > 1) {
        newServer = new MockIpcServer(ipcPath);
        await newServer.start();
        newServerReady();
      }
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrReader = new NdjsonLineReader(stderr);
    const exit = vi.fn();

    const { SHIM_VERSION: shimVersion } = await import('../src/daemon-launcher.js');

    const bridgePromise = createBridge({
      ipcPath,
      pidFile: resolve(dir, 'daemon.pid'),
      daemonBin: 'mesh-daemon',
      appName: 'claude-desktop',
      stdin,
      stdout,
      stderr,
      exit,
      ensureDaemon,
      stopDaemon: stopDaemonMock,
      startupTimeoutMs: 5_000,
    });

    const oldHello = await oldServer.nextMessage();
    // Legacy daemon: no daemonVersion field
    oldServer.send({
      jsonrpc: '2.0',
      id: oldHello.id,
      result: { acknowledged: true, connectionId: 'legacy' },
    });

    // Should trigger upgrade
    await newServerPromise;
    const newHello = await newServer!.nextMessage();
    newServer!.send({
      jsonrpc: '2.0',
      id: newHello.id,
      result: { acknowledged: true, connectionId: 'new', daemonVersion: shimVersion },
    });

    const bridge = await bridgePromise;

    // Legacy daemons without version SHOULD be upgraded
    expect(stopDaemonMock).toHaveBeenCalledTimes(1);
    expect(ensureDaemon).toHaveBeenCalledTimes(2);

    const stderrOutput = stderrReader.lines().join('');
    expect(stderrOutput).toContain('Upgrading daemon from vunknown');

    bridge.close();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
