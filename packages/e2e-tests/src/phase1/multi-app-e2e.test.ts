import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

import type { DaemonFullConfig } from '@hivemind-os/collective-daemon/config';
import { getDefaultConfig } from '@hivemind-os/collective-daemon/config';
import { IpcServer } from '@hivemind-os/collective-daemon/ipc/server';
import { DaemonState } from '@hivemind-os/collective-daemon/state';
import { afterEach, describe, expect, it } from 'vitest';

const createdPaths: string[] = [];
const openSockets = new Set<net.Socket>();

interface ConnectedAppSnapshot {
  appName?: string;
  appPid?: number;
  pid?: number;
  profile?: string;
  connectedAt?: number;
}

interface HelloResponse {
  id: string | number;
  result: {
    acknowledged: boolean;
    connectionId: string;
  };
}

interface InitializeResponse {
  id: string | number;
  result: {
    capabilities: {
      tools?: unknown;
    };
  };
}

interface DaemonStatusResponse {
  id: string | number;
  result: {
    did: string;
    providerRunning: boolean;
    connectedApps: ConnectedAppSnapshot[];
  };
}

interface MeshStatusToolResponse {
  id: string | number;
  result: {
    structuredContent: {
      connectedApps: ConnectedAppSnapshot[];
    };
  };
}

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

  async request<T = unknown>(message: unknown): Promise<T> {
    await this.send(message);
    return this.nextMessage<T>();
  }

  async nextMessage<T = unknown>(): Promise<T> {
    if (this.messages.length > 0) {
      return this.messages.shift() as T;
    }

    return new Promise((resolvePromise) => {
      this.waiters.push((message) => {
        resolvePromise(message as T);
      });
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

afterEach(async () => {
  for (const socket of [...openSockets]) {
    await closeSocket(socket);
  }

  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Phase 1 E2E: Multi-app IPC', () => {
  it('accepts two simultaneous client connections on the same IPC server', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);
    const firstPid = getClientPid(101);
    const secondPid = getClientPid(202);

    const firstHello = await sendHello(first, 'claude-desktop', firstPid);
    const secondHello = await sendHello(second, 'vscode', secondPid);

    expect(firstHello.result.connectionId).not.toBe(secondHello.result.connectionId);
    expect(server.getConnectedApps()).toHaveLength(2);

    await server.stop();
    await state.shutdown();
  });

  it('returns independent responses to each connected client', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);
    const firstPid = getClientPid(301);
    const secondPid = getClientPid(302);

    await initializeClient(first, 'claude-desktop', firstPid, 'default');
    await initializeClient(second, 'vscode', secondPid, 'workspace');

    const [firstStatus, secondStatus] = await Promise.all([
      first.request<MeshStatusToolResponse>({
        jsonrpc: '2.0',
        id: 'first-status',
        method: 'tools/call',
        params: { name: 'collective_status', arguments: {} },
      }),
      second.request<MeshStatusToolResponse>({
        jsonrpc: '2.0',
        id: 'second-status',
        method: 'tools/call',
        params: { name: 'collective_status', arguments: {} },
      }),
    ]);

    expect(firstStatus.id).toBe('first-status');
    expect(secondStatus.id).toBe('second-status');
    expect(firstStatus.result.structuredContent.connectedApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ appName: 'claude-desktop', pid: firstPid, profile: 'default' }),
        expect.objectContaining({ appName: 'vscode', pid: secondPid, profile: 'workspace' }),
      ]),
    );
    expect(secondStatus.result.structuredContent.connectedApps).toEqual(firstStatus.result.structuredContent.connectedApps);

    await server.stop();
    await state.shutdown();
  });

  it("keeps the remaining client connected when another client disconnects", async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);
    const firstPid = getClientPid(401);
    const secondPid = getClientPid(402);

    await initializeClient(first, 'claude-desktop', firstPid);
    await initializeClient(second, 'vscode', secondPid);
    await closeSocket(first.socket);

    const response = await second.request<MeshStatusToolResponse>({
      jsonrpc: '2.0',
      id: 'remaining-status',
      method: 'tools/call',
      params: { name: 'collective_status', arguments: {} },
    });

    expect(server.getConnectedApps()).toMatchObject([{ appName: 'vscode', appPid: secondPid }]);
    expect(response.result.structuredContent.connectedApps).toHaveLength(1);
    expect(response.result.structuredContent.connectedApps[0]).toMatchObject({ appName: 'vscode', pid: secondPid });

    await server.stop();
    await state.shutdown();
  });

  it('tracks all connected applications in the connection registry', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);
    const firstPid = getClientPid(501);
    const secondPid = getClientPid(502);

    await sendHello(first, 'claude-desktop', firstPid, 'default');
    await sendHello(second, 'vscode', secondPid, 'workspace');

    expect(server.getConnectedApps()).toMatchObject([
      { appName: 'claude-desktop', appPid: firstPid, profile: 'default' },
      { appName: 'vscode', appPid: secondPid, profile: 'workspace' },
    ]);

    await server.stop();
    await state.shutdown();
  });

  it('reports the current connected app list via daemon_status', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);
    const firstPid = getClientPid(601);
    const secondPid = getClientPid(602);

    await sendHello(first, 'claude-desktop', firstPid, 'default');
    await sendHello(second, 'vscode', secondPid);

    const response = await second.request<DaemonStatusResponse>({
      jsonrpc: '2.0',
      id: 'daemon-status',
      method: 'daemon_status',
    });

    expect(response.result.did).toBe(state.did);
    expect(response.result.providerRunning).toBe(false);
    expect(response.result.connectedApps).toEqual([
      expect.objectContaining({ appName: 'claude-desktop', connectedAt: expect.any(Number) }),
      expect.objectContaining({ appName: 'vscode', connectedAt: expect.any(Number) }),
    ]);

    await server.stop();
    await state.shutdown();
  });
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.artifacts', `multi-app-${randomUUID()}`);
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createIpcPath(dir: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\hivemind-collective-e2e-${randomUUID()}` : resolve(dir, 'hivemind-collective.sock');
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
      mode: 'filesystem',
      filesystem: {
        dataDir: resolve(dir, 'blobs'),
      },
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

async function sendHello(client: TestClient, appName: string, pid: number, profile?: string): Promise<HelloResponse> {
  const response = await client.request<HelloResponse>({
    jsonrpc: '2.0',
    id: `${appName}-hello`,
    method: 'shim_hello',
    params: { appName, pid, profile },
  });

  expect(response.result.acknowledged).toBe(true);
  return response;
}

async function initializeClient(client: TestClient, appName: string, pid: number, profile?: string): Promise<void> {
  await sendHello(client, appName, pid, profile);
  const initialize = await client.request<InitializeResponse>({
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

function getClientPid(fallbackPid: number): number {
  return process.platform === 'win32' ? process.pid : fallbackPid;
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
