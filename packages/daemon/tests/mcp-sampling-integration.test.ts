/**
 * Integration test for the MCP sampling adapter.
 *
 * Exercises the full round-trip: IpcServer → Connection → McpSession → Server
 * → IPC transport → mock MCP client → response flows back.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { IpcServer } from '../src/ipc/server.js';
import { DaemonState } from '../src/state.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const createdPaths: string[] = [];
const openSockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of [...openSockets]) {
    await closeSocket(socket);
  }

  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Test helpers (modelled on ipc.test.ts / multi-app.test.ts)
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

  async nextMessage(): Promise<JsonRpcMessage> {
    if (this.messages.length > 0) {
      return this.messages.shift()!;
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

/**
 * Initialize an MCP client with sampling capability declared.
 */
async function initializeWithSampling(
  client: TestClient,
  appName: string,
  pid: number,
): Promise<void> {
  const hello = (await client.request({
    jsonrpc: '2.0',
    id: `${appName}-hello`,
    method: 'shim_hello',
    params: { appName, pid },
  })) as JsonRpcMessage & { result?: { acknowledged: boolean } };
  expect(hello.result?.acknowledged).toBe(true);

  const initialize = (await client.request({
    jsonrpc: '2.0',
    id: `${appName}-initialize`,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {
        sampling: {},
      },
      clientInfo: {
        name: appName,
        version: '1.0.0',
      },
    },
  })) as JsonRpcMessage & { result?: { capabilities: unknown } };
  expect(initialize.result?.capabilities).toBeDefined();

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP sampling integration', () => {
  it('round-trips a sampling request through the full IPC stack', async () => {
    const { server, state, ipcPath } = await startServer();

    // Connect a mock MCP client that supports sampling
    const client = await connectClient(ipcPath);
    await initializeWithSampling(client, 'test-llm-app', 9999);

    // The mock client listens for sampling/createMessage requests in the
    // background and responds with a canned LLM response.
    const clientHandler = (async () => {
      const samplingRequest = await client.nextMessage();

      expect(samplingRequest.method).toBe('sampling/createMessage');

      const params = samplingRequest.params as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
        systemPrompt: string;
        maxTokens: number;
      };
      expect(params.systemPrompt).toBe('Translate to French.');
      expect(params.messages).toHaveLength(1);
      expect(params.messages[0].role).toBe('user');
      expect(params.messages[0].content.text).toBe('Hello world');
      expect(params.maxTokens).toBe(2048);

      // Respond as an MCP client would
      await client.send({
        jsonrpc: '2.0',
        id: samplingRequest.id,
        result: {
          role: 'assistant',
          content: { type: 'text', text: 'Bonjour le monde' },
          model: 'claude-sonnet-4-20250514',
          stopReason: 'endTurn',
        },
      });
    })();

    // Now call Server.createMessage() via the IpcServer bridge
    const mcpServer = server.getMcpServerForApp('test-llm-app');
    expect(mcpServer).toBeDefined();

    const result = await mcpServer!.createMessage({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: 'Hello world' },
        },
      ],
      systemPrompt: 'Translate to French.',
      maxTokens: 2048,
    });

    // Wait for the client handler to complete its assertions
    await clientHandler;

    // Verify the response
    const content = result.content;
    const textContent = Array.isArray(content)
      ? content.find((c) => c.type === 'text')
      : content;
    expect(textContent).toBeDefined();
    expect(textContent!.type).toBe('text');
    expect((textContent as { type: 'text'; text: string }).text).toBe('Bonjour le monde');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.stopReason).toBe('endTurn');

    await server.stop();
    await state.shutdown();
  });

  it('full adapter round-trip: McpSamplingAdapter → IPC → mock client → response', async () => {
    const { McpSamplingAdapter } = await import('../src/provider/adapters/mcp-sampling.js');

    const { server, state, ipcPath } = await startServer();

    // Connect mock MCP client
    const client = await connectClient(ipcPath);
    await initializeWithSampling(client, 'my-agent', 1234);

    // Create the adapter with a real sampling function bridged through IpcServer
    const adapter = new McpSamplingAdapter(
      {
        appName: 'my-agent',
        systemPrompt: 'You are a helpful assistant.',
        maxTokens: 1024,
      },
      async (appName, params) => {
        const srv = server.getMcpServerForApp(appName);
        if (!srv) throw new Error(`No client: ${appName}`);
        return srv.createMessage(params);
      },
    );

    // Mock client handler
    const clientHandler = (async () => {
      const req = await client.nextMessage();
      expect(req.method).toBe('sampling/createMessage');

      const params = req.params as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
        systemPrompt: string;
      };
      expect(params.systemPrompt).toBe('You are a helpful assistant.');
      expect(params.messages[0].content.text).toBe('What is 2+2?');

      await client.send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          role: 'assistant',
          content: { type: 'text', text: 'The answer is 4.' },
          model: 'test-model',
          stopReason: 'endTurn',
        },
      });
    })();

    // Execute through the adapter
    const result = await adapter.execute({
      taskId: 'task-integration-1',
      capability: 'qa',
      inputData: encoder.encode('What is 2+2?'),
    });

    await clientHandler;

    expect(decoder.decode(result.resultData)).toBe('The answer is 4.');
    expect(result.metadata?.model).toBe('test-model');
    expect(result.metadata?.stopReason).toBe('endTurn');

    await server.stop();
    await state.shutdown();
  });

  it('getMcpServerForApp returns undefined when no app is connected', async () => {
    const { server, state } = await startServer();

    expect(server.getMcpServerForApp('nonexistent')).toBeUndefined();

    await server.stop();
    await state.shutdown();
  });

  it('getMcpServerForApp throws on ambiguous matches', async () => {
    const { server, state, ipcPath } = await startServer();

    // Connect two clients with the same appName
    const client1 = await connectClient(ipcPath);
    await initializeWithSampling(client1, 'duplicate-app', 1001);

    const client2 = await connectClient(ipcPath);
    await initializeWithSampling(client2, 'duplicate-app', 1002);

    expect(() => server.getMcpServerForApp('duplicate-app')).toThrow('Ambiguous');

    await server.stop();
    await state.shutdown();
  });
});
