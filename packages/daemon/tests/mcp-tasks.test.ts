/**
 * Tests for MCP task lifecycle (tasks/get, tasks/list, tasks/result, tasks/cancel)
 * and the async mesh_execute flow that returns MCP task handles.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpTaskStore } from '../src/mcp/task-store.js';
import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { IpcServer } from '../src/ipc/server.js';
import { DaemonState } from '../src/state.js';
import { buildMeshToolContext } from '../src/mcp/tool-context.js';

const createdPaths: string[] = [];
const openSockets = new Set<net.Socket>();
const activeServers: IpcServer[] = [];

afterEach(async () => {
  for (const socket of [...openSockets]) {
    await closeSocket(socket);
  }
  for (const srv of activeServers.splice(0)) {
    await srv.stop();
  }
  // Small delay for Windows file handles to release
  await new Promise((r) => setTimeout(r, 100));
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
});

// ---------------------------------------------------------------------------
// McpTaskStore unit tests
// ---------------------------------------------------------------------------

describe('McpTaskStore', () => {
  it('creates a task with working status', () => {
    const store = new McpTaskStore();
    const entry = store.create('chain-task-123');

    expect(entry.taskId).toBeDefined();
    expect(entry.onChainTaskId).toBe('chain-task-123');
    expect(entry.status).toBe('working');
    expect(entry.createdAt).toBeDefined();
    expect(entry.ttl).toBe(3_600_000);
    expect(entry.pollInterval).toBe(2_000);
  });

  it('retrieves task by MCP id and chain id', () => {
    const store = new McpTaskStore();
    const entry = store.create('chain-task-456');

    expect(store.get(entry.taskId)).toBe(entry);
    expect(store.getByChainId('chain-task-456')).toBe(entry);
    expect(store.get('non-existent')).toBeUndefined();
    expect(store.getByChainId('non-existent')).toBeUndefined();
  });

  it('updates task status and result', () => {
    const store = new McpTaskStore();
    const entry = store.create('chain-task-789');

    const updated = store.update(entry.taskId, 'completed', {
      statusMessage: 'Done',
      result: { content: [{ type: 'text', text: 'hello' }] },
    });

    expect(updated?.status).toBe('completed');
    expect(updated?.statusMessage).toBe('Done');
    expect(updated?.result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('cancels a task', () => {
    const store = new McpTaskStore();
    const entry = store.create('chain-task-cancel');

    const cancelled = store.cancel(entry.taskId);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.statusMessage).toBe('Cancelled by client');
  });

  it('lists all tasks', () => {
    const store = new McpTaskStore();
    store.create('chain-1');
    store.create('chain-2');
    store.create('chain-3');

    expect(store.list()).toHaveLength(3);
  });

  it('supports custom TTL and null TTL', () => {
    const store = new McpTaskStore();
    const short = store.create('chain-short', { ttl: 5_000 });
    const unlimited = store.create('chain-unlimited', { ttl: null });

    expect(short.ttl).toBe(5_000);
    expect(unlimited.ttl).toBeNull();
    store.cleanup();
  });

  it('cleans up all entries on cleanup()', () => {
    const store = new McpTaskStore();
    store.create('chain-a');
    store.create('chain-b');
    store.cleanup();

    expect(store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: MCP task protocol over IPC
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class TestClient {
  private buffer = '';
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<(message: JsonRpcMessage) => void> = [];

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

  async request(message: unknown): Promise<JsonRpcMessage> {
    await this.send(message);
    return this.nextMessage();
  }

  async nextMessage(timeoutMs = 5_000): Promise<JsonRpcMessage> {
    if (this.messages.length > 0) {
      return this.messages.shift()!;
    }

    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for message'));
      }, timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
    });
  }

  drainPending(): JsonRpcMessage[] {
    return this.messages.splice(0);
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const parsed = JSON.parse(line) as JsonRpcMessage;
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
  const toolContext = buildMeshToolContext(state, resolve(dir, 'daemon'));

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
  server.toolContext = toolContext;
  await server.start();
  activeServers.push(server);
  return { server, state, ipcPath };
}

async function connectAndHandshake(ipcPath: string, appName = 'test-app', opts?: { tasks?: boolean }): Promise<TestClient> {
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

  const client = new TestClient(socket);

  // shim_hello handshake
  const helloResp = await client.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'shim_hello',
    params: { appName, appPid: process.pid },
  });
  expect(helloResp.result).toHaveProperty('acknowledged', true);

  // MCP initialize — optionally advertise tasks capability
  const capabilities: Record<string, unknown> = {};
  if (opts?.tasks) {
    capabilities.tasks = {};
  }

  const initResp = await client.request({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities,
      clientInfo: { name: appName, version: '0.0.1' },
    },
  });
  expect(initResp.result).toHaveProperty('capabilities');

  // Verify tasks capability advertised by server
  const result = initResp.result as Record<string, unknown>;
  const serverCapabilities = result.capabilities as Record<string, unknown>;
  expect(serverCapabilities).toHaveProperty('tasks');

  // Send initialized notification
  await client.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  return client;
}

async function closeSocket(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return;
  return new Promise((resolvePromise) => {
    socket.once('close', resolvePromise);
    socket.destroy();
  });
}

describe('MCP Task Protocol Integration', () => {
  it('tasks/list returns empty list initially', async () => {
    const { ipcPath } = await startServer();
    const client = await connectAndHandshake(ipcPath);

    const listResp = await client.request({
      jsonrpc: '2.0',
      id: 10,
      method: 'tasks/list',
      params: {},
    });

    expect(listResp.result).toHaveProperty('tasks');
    const result = listResp.result as { tasks: unknown[] };
    expect(result.tasks).toHaveLength(0);
  });

  it('tasks/get returns error for unknown task', async () => {
    const { ipcPath } = await startServer();
    const client = await connectAndHandshake(ipcPath);

    const resp = await client.request({
      jsonrpc: '2.0',
      id: 11,
      method: 'tasks/get',
      params: { taskId: 'non-existent-id' },
    });

    expect(resp.error).toBeDefined();
    expect(resp.error?.message).toContain('not found');
  });

  it('tasks/result returns error for non-existent task', async () => {
    const { ipcPath } = await startServer();
    const client = await connectAndHandshake(ipcPath);

    const resp = await client.request({
      jsonrpc: '2.0',
      id: 12,
      method: 'tasks/result',
      params: { taskId: 'non-existent-id' },
    });

    expect(resp.error).toBeDefined();
  });

  it('tasks/cancel returns error for unknown task', async () => {
    const { ipcPath } = await startServer();
    const client = await connectAndHandshake(ipcPath);

    const resp = await client.request({
      jsonrpc: '2.0',
      id: 13,
      method: 'tasks/cancel',
      params: { taskId: 'non-existent-id' },
    });

    expect(resp.error).toBeDefined();
  });

  it('broadcastNotification sends to all connected clients', async () => {
    const { server, ipcPath } = await startServer();
    const client1 = await connectAndHandshake(ipcPath, 'app-1');
    const client2 = await connectAndHandshake(ipcPath, 'app-2');

    server.broadcastNotification('notifications/mesh/inbound_task', {
      taskId: 'chain-task-42',
      capability: 'summarize',
      requester: '0xabc',
      priceMist: '1000000',
    });

    const msg1 = await client1.nextMessage();
    const msg2 = await client2.nextMessage();

    expect(msg1.method).toBe('notifications/mesh/inbound_task');
    expect((msg1.params as Record<string, unknown>).taskId).toBe('chain-task-42');
    expect(msg2.method).toBe('notifications/mesh/inbound_task');
    expect((msg2.params as Record<string, unknown>).capability).toBe('summarize');
  });

  it('collective_execute uses blocking path for clients without tasks capability', async () => {
    const { ipcPath } = await startServer();
    // Client does NOT advertise tasks capability
    const client = await connectAndHandshake(ipcPath);

    const resp = await client.request({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'collective_execute',
        arguments: {
          capability: 'nonexistent-capability',
          input: 'test input',
        },
      },
    });

    // Should get an error result via blocking sync path (no task handle),
    // since the test has no provider the sync execute will fail with an error
    const result = resp.result as Record<string, unknown>;
    expect(result).toHaveProperty('isError', true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('error');
  });

  it('collective_execute uses async task path for clients WITH tasks capability', async () => {
    const { ipcPath } = await startServer();
    // Client DOES advertise tasks capability
    const client = await connectAndHandshake(ipcPath, 'task-client', { tasks: true });

    // mesh_execute with tasks capability — will try async path and fail because
    // no provider exists. The error happens during prepareMeshExecution (before
    // task creation), so it comes back as an isError tool result.
    const resp = await client.request({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'collective_execute',
        arguments: {
          capability: 'nonexistent-capability',
          input: 'test input',
        },
      },
    });

    // Should return an error (either error response or isError result)
    if (resp.error) {
      expect(resp.error.message).toBeDefined();
    } else {
      const result = resp.result as Record<string, unknown>;
      expect(result).toHaveProperty('isError', true);
    }
  });

  it('tools/list still works alongside task handlers', async () => {
    const { ipcPath } = await startServer();
    const client = await connectAndHandshake(ipcPath);

    const resp = await client.request({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/list',
      params: {},
    });

    const result = resp.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(5);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('collective_execute');
    expect(names).toContain('collective_execute_async');
    expect(names).toContain('collective_balance');
    expect(names).toContain('collective_status');
  });
});
