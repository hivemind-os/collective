import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

import { PaymentRail, SpendingPolicyEngine } from '@hivemind-os/collective-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../src/audit.js';
import { subscribeAuditEvents } from '../src/audit.js';
import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { IpcServer } from '../src/ipc/server.js';
import { DaemonState } from '../src/state.js';

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
    spendingToday?: string;
    connectedApps: ConnectedAppSnapshot[];
  };
}

interface MeshStatusToolResponse {
  id: string | number;
  result: {
    structuredContent: {
      did?: string;
      providerRunning?: boolean;
      connectedApps: ConnectedAppSnapshot[];
    };
  };
}

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

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createIpcPath(_dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\hivemind-collective-test-${randomUUID()}`;
  }
  // Unix socket paths have a 108-char limit; use /tmp with a short name
  const short = randomUUID().slice(0, 8);
  return `/tmp/hm-test-${short}.sock`;
}

async function startServer(
  spending?: DaemonFullConfig['spending'],
): Promise<{ server: IpcServer; state: DaemonState; ipcPath: string }> {
  const dir = await createTestDir();
  const ipcPath = createIpcPath(dir);
  const defaults = getDefaultConfig();
  const config: DaemonFullConfig = {
    ...defaults,
    identity: { dataDir: resolve(dir, 'identity') },
    spending: spending ?? defaults.spending,
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
  const server = new IpcServer(ipcPath, state, {
    validateClient: async () => ({
      allowed: true,
      source: process.platform === 'win32' ? 'windows-pid' : 'unix-socket',
    }),
    verifyPipeSecurity: async () => ({
      transport: process.platform === 'win32' ? 'windows-pipe' : 'unix-socket',
      userScoped: true,
      aclVerified: process.platform !== 'win32',
      note: 'test override',
    }),
  });
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

async function initializeSession(client: TestClient, appName: string): Promise<void> {
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

describe('multi-app daemon support', () => {
  it('tracks multiple apps, exposes daemon_status, and keeps remaining sessions alive', async () => {
    const { server, state, ipcPath } = await startServer();
    const first = await connectClient(ipcPath);
    const second = await connectClient(ipcPath);

    const firstHello = await sendHello(first, 'claude-desktop', 101, 'default');
    const secondHello = await sendHello(second, 'vscode', 202);

    expect(firstHello.result.connectionId).not.toBe(secondHello.result.connectionId);
    expect(server.getConnectedApps()).toMatchObject([
      { appName: 'claude-desktop', appPid: 101, profile: 'default' },
      { appName: 'vscode', appPid: 202 },
    ]);

    await initializeSession(second, 'vscode');
    await closeSocket(first.socket);

    expect(server.getConnectedApps()).toMatchObject([{ appName: 'vscode', appPid: 202 }]);

    const daemonStatus = await second.request<DaemonStatusResponse>({
      jsonrpc: '2.0',
      id: 'daemon-status',
      method: 'daemon_status',
    });
    expect(daemonStatus.result).toMatchObject({
      did: state.did,
      providerRunning: false,
      spendingToday: '0 SUI',
    });
    expect(daemonStatus.result.connectedApps).toEqual([
      expect.objectContaining({ appName: 'vscode', connectedAt: expect.any(Number) }),
    ]);

    const meshStatus = await second.request<MeshStatusToolResponse>({
      jsonrpc: '2.0',
      id: 'mesh-status',
      method: 'tools/call',
      params: {
        name: 'collective_status',
        arguments: {},
      },
    });
    expect(meshStatus.result.structuredContent.connectedApps).toHaveLength(1);
    expect(meshStatus.result.structuredContent.connectedApps[0]).toMatchObject({
      appName: 'vscode',
      pid: 202,
    });

    await server.stop();
    await state.shutdown();
  });

  it('emits audit events with app names', async () => {
    const events: AuditEvent[] = [];
    const unsubscribe = subscribeAuditEvents((event) => {
      events.push(event);
    });

    const { server, state, ipcPath } = await startServer();
    const client = await connectClient(ipcPath);

    await sendHello(client, 'audit-app', 303);
    await initializeSession(client, 'audit-app');
    await client.request({
      jsonrpc: '2.0',
      id: 'audit-status',
      method: 'tools/call',
      params: {
        name: 'collective_status',
        arguments: {},
      },
    });
    await closeSocket(client.socket);
    unsubscribe();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'app_connected', appName: 'audit-app', appPid: 303 }),
        expect.objectContaining({ event: 'tool_call', appName: 'audit-app', tool: 'collective_status' }),
        expect.objectContaining({ event: 'app_disconnected', appName: 'audit-app' }),
      ]),
    );

    await server.stop();
    await state.shutdown();
  });

  it('enforces per-app spending limits separately from global limits', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
        perApp: {
          'claude-desktop': {
            limits: [{ amount: 50n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
          },
        },
      },
      dbPath: resolve(await createTestDir(), 'spending.sqlite'),
    });

    expect(
      engine.evaluate({ amountMist: 40n, rail: PaymentRail.SUI_ESCROW, originAppName: 'claude-desktop' }).approved,
    ).toBe(true);
    engine.record({
      amountMist: 40n,
      rail: PaymentRail.SUI_ESCROW,
      taskId: 'task-1',
      originAppName: 'claude-desktop',
    });

    expect(
      engine.evaluate({ amountMist: 15n, rail: PaymentRail.SUI_ESCROW, originAppName: 'claude-desktop' }).approved,
    ).toBe(false);
    expect(engine.evaluate({ amountMist: 15n, rail: PaymentRail.SUI_ESCROW, originAppName: 'vscode' }).approved).toBe(
      true,
    );

    engine.close();
  });

  it('applies global limits across all apps combined', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: resolve(await createTestDir(), 'spending.sqlite'),
    });

    engine.record({
      amountMist: 40n,
      rail: PaymentRail.SUI_ESCROW,
      taskId: 'task-1',
      originAppName: 'claude-desktop',
    });
    engine.record({
      amountMist: 50n,
      rail: PaymentRail.SUI_ESCROW,
      taskId: 'task-2',
      originAppName: 'vscode',
    });

    expect(engine.evaluate({ amountMist: 10n, rail: PaymentRail.SUI_ESCROW, originAppName: 'cursor' }).approved).toBe(
      true,
    );
    expect(engine.evaluate({ amountMist: 11n, rail: PaymentRail.SUI_ESCROW, originAppName: 'cursor' }).approved).toBe(
      false,
    );

    engine.close();
  });
});
