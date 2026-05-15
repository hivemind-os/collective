import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { IpcServer } from '../src/ipc/server.js';
import { DaemonState } from '../src/state.js';

const createdPaths: string[] = [];
const openSockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of [...openSockets]) {
    await closeSocket(socket);
  }

  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class TestClient {
  private buffer = '';
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];

  constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });
  }

  async send(message: unknown): Promise<void> {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  async request(message: unknown): Promise<unknown> {
    await this.send(message);
    return this.nextMessage();
  }

  async nextMessage(): Promise<unknown> {
    if (this.messages.length > 0) {
      return this.messages.shift();
    }

    return new Promise((resolvePromise) => {
      this.waiters.push(resolvePromise);
    });
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const parsed = JSON.parse(line) as unknown;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(parsed);
        } else {
          this.messages.push(parsed);
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }
}

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createIpcPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentic-mesh-test-${randomUUID()}`
    : resolve(dir, 'agentic-mesh.sock');
}

async function startServer(): Promise<{ server: IpcServer; state: DaemonState; ipcPath: string }> {
  const dir = await createTestDir();
  const ipcPath = createIpcPath(dir);
  const defaults = getDefaultConfig();
  const config: DaemonFullConfig = {
    ...defaults,
    identity: { dataDir: resolve(dir, 'identity') },
    daemon: {
      ...defaults.daemon,
      ipcPath,
      dataDir: resolve(dir, 'daemon'),
      pidFile: resolve(dir, 'daemon.pid'),
      logLevel: 'error',
    },
    blobstore: {
      type: 'filesystem',
      baseDir: resolve(dir, 'blobs'),
    },
  };

  const state = await DaemonState.create(config);
  const server = new IpcServer(ipcPath, state);
  await server.start();
  return { server, state, ipcPath };
}

async function connectClient(ipcPath: string): Promise<TestClient> {
  const socket = await new Promise<net.Socket>((resolvePromise, reject) => {
    const client = net.connect(ipcPath, () => {
      resolvePromise(client);
    });
    client.once('error', reject);
  });
  openSockets.add(socket);
  socket.once('close', () => {
    openSockets.delete(socket);
  });
  return new TestClient(socket);
}

async function initializeClient(client: TestClient, appName: string, pid: number, profile?: string): Promise<void> {
  const hello = await client.request({
    jsonrpc: '2.0',
    id: `${appName}-hello`,
    method: 'shim_hello',
    params: { appName, pid, profile },
  });
  expect(hello.result.acknowledged).toBe(true);

  const initialize = await client.request({
    jsonrpc: '2.0',
    id: `${appName}-initialize`,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: appName,
        version: '1.0.0',
      },
    },
  });
  expect(initialize.result.capabilities.tools).toBeDefined();

  await client.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
}

async function closeSocket(socket: net.Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }

  await new Promise<void>((resolvePromise) => {
    socket.once('close', () => {
      resolvePromise();
    });
    socket.end();
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }, 25);
  });
}

describe('ipc server', () => {
  it('starts and accepts connections on the IPC endpoint', async () => {
    const { server, state, ipcPath } = await startServer();
    const client = await connectClient(ipcPath);

    const hello = await client.request({
      jsonrpc: '2.0',
      id: 'hello',
      method: 'shim_hello',
      params: { appName: 'accept-test', pid: 100 },
    });

    expect(hello.result.acknowledged).toBe(true);

    await server.stop();
    await state.shutdown();
  });

  it('round-trips JSON-RPC requests through the MCP session', async () => {
    const { server, state, ipcPath } = await startServer();
    const client = await connectClient(ipcPath);
    await initializeClient(client, 'roundtrip-app', 200);

    const response = await client.request({
      jsonrpc: '2.0',
      id: 'status',
      method: 'tools/call',
      params: {
        name: 'mesh_status',
        arguments: {},
      },
    });

    expect(response.result.structuredContent.did).toBe(state.did);
    expect(response.result.structuredContent.connectedApps).toHaveLength(1);

    await server.stop();
    await state.shutdown();
  });

  it('handles multiple simultaneous connections', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);

    await initializeClient(first, 'first-app', 301);
    await initializeClient(second, 'second-app', 302);

    const response = await second.request({
      jsonrpc: '2.0',
      id: 'status-2',
      method: 'tools/call',
      params: {
        name: 'mesh_status',
        arguments: {},
      },
    });

    expect(response.result.structuredContent.connectedApps).toHaveLength(2);

    await server.stop();
    await state.shutdown();
  });

  it('stopping the server closes active connections', async () => {
    const { server, state, ipcPath } = await startServer();
    const client = await connectClient(ipcPath);
    await initializeClient(client, 'close-app', 401);

    const closed = new Promise<void>((resolvePromise) => {
      client.socket.once('close', () => {
        resolvePromise();
      });
    });

    await server.stop();
    await closed;
    await state.shutdown();
  });

  it('registers shim metadata in mesh_status responses', async () => {
    const { server, state, ipcPath } = await startServer();
    const client = await connectClient(ipcPath);
    await initializeClient(client, 'metadata-app', 501, 'default');

    const response = await client.request({
      jsonrpc: '2.0',
      id: 'metadata-status',
      method: 'tools/call',
      params: {
        name: 'mesh_status',
        arguments: {},
      },
    });

    expect(response.result.structuredContent.connectedApps[0]).toMatchObject({
      appName: 'metadata-app',
      pid: 501,
      profile: 'default',
    });

    await server.stop();
    await state.shutdown();
  });
});
