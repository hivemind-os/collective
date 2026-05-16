import { describe, expect, it, vi } from 'vitest';

import type { AuthProvider } from '@hivemind-os/collective-core';

const wsState = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    private listeners = new Map<string, Set<Listener>>();

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = [...(this.listeners.get(event) ?? [])];
      listeners.forEach((listener) => listener(...args));
      return listeners.length > 0;
    }

    send(payload: string, callback?: (error?: Error) => void): void {
      this.sent.push(payload);
      callback?.();
    }

    close(code?: number, reason?: string): void {
      void code;
      void reason;
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({ default: wsState.MockWebSocket }));

import { RelayClient } from '../src/relay/relay-client.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for relay test condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('RelayClient', () => {
  it('authenticates and replies to relay task requests', async () => {
    wsState.MockWebSocket.instances = [];
    const identity = {
      getDID: () => 'did:mesh:provider',
      toSuiSigner: () => ({
        sign: vi.fn(async () => new Uint8Array([1, 2, 3])),
      }),
    } as unknown as AuthProvider;

    const client = new RelayClient({ relayUrl: 'ws://relay.example', heartbeatIntervalMs: 60_000 }, identity);
    client.onTaskRequest(async (request) => ({
      taskId: request.taskId ?? 'task-1',
      providerDid: 'did:mesh:provider',
      sequence: 1,
      result: { echoed: request.input },
    }));

    const connectPromise = client.connect(['echo']);
    await waitUntil(() => wsState.MockWebSocket.instances.length === 1);
    const socket = wsState.MockWebSocket.instances[0]!;

    await waitUntil(() => socket.sent.length === 1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'auth',
      did: 'did:mesh:provider',
      capabilities: ['echo'],
    });

    socket.emit('message', JSON.stringify({ type: 'auth_ok', sessionId: 'session-1', relayDid: 'did:mesh:relay' }));
    await connectPromise;
    expect(client.isConnected).toBe(true);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'task_request',
        sessionId: 'session-1',
        taskId: 'task-1',
        capability: 'echo',
        input: { text: 'hello' },
        requesterDid: 'did:mesh:consumer',
        sequence: 1,
      }),
    );

    await waitUntil(() => socket.sent.length === 2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: 'task_result',
      sessionId: 'session-1',
      taskId: 'task-1',
      sequence: 1,
      result: { echoed: { text: 'hello' } },
    });

    await client.disconnect();
  });
});
