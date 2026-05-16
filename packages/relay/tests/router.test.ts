import { EventEmitter } from 'node:events';

import { createDID, generateKeypair, signString } from '@hivemind-os/collective-core';
import type { DID } from '@hivemind-os/collective-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { createAuthPayload, type AuthMessage, type TaskStreamEvent } from '../src/routing/message-types.js';
import { RelayRouteError, RelayRouter } from '../src/routing/router.js';
import { SessionManager } from '../src/routing/session-manager.js';

class TestSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

function createAuthMessage(capabilities: string[]): { did: DID; authMessage: AuthMessage } {
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  const authMessage: AuthMessage = {
    type: 'auth',
    did,
    nonce: 'router-nonce',
    capabilities,
    signature: signString(createAuthPayload({ did, nonce: 'router-nonce', capabilities }), keypair.secretKey),
  };

  return { did, authMessage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('relay router', () => {
  it('routes a task to a connected provider and returns the result', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const provider = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });
    const requesterDid = createAuthMessage([]).did;

    const responsePromise = router.routeTask({
      requesterDid,
      providerDid: provider.did,
      capability: 'weather',
      input: { location: 'SF' },
    });

    const outbound = JSON.parse(socket.sent[0] ?? '{}') as { taskId: string; sequence: number };
    router.handleProviderMessage(session.sessionId, {
      type: 'task_result',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 1,
      result: { temperature: 18.5 },
    });

    await expect(responsePromise).resolves.toEqual({
      taskId: outbound.taskId,
      providerDid: provider.did,
      sequence: 1,
      result: { temperature: 18.5 },
    });
    expect(outbound.sequence).toBe(1);
  });

  it('errors when no provider is connected', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });

    await expect(
      router.routeTask({
        requesterDid: createAuthMessage([]).did,
        providerDid: createAuthMessage([]).did,
        capability: 'weather',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' satisfies RelayRouteError['code'] });
  });

  it('returns a timeout error when the provider does not respond', async () => {
    vi.useFakeTimers();
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const provider = createAuthMessage(['weather']);
    manager.registerSession(new TestSocket() as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 100 });

    const responsePromise = router.routeTask({
      requesterDid: createAuthMessage([]).did,
      providerDid: provider.did,
      capability: 'weather',
      input: {},
    });
    const assertion = expect(responsePromise).rejects.toMatchObject({
      code: 'TASK_TIMEOUT' satisfies RelayRouteError['code'],
    });

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });

  it('streams progress and chunks before completing', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const provider = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });
    const events: TaskStreamEvent[] = [];

    const responsePromise = router.routeStreamingTask(
      {
        requesterDid: createAuthMessage([]).did,
        providerDid: provider.did,
        capability: 'weather',
        input: { location: 'Berlin' },
      },
      (event) => {
        events.push(event);
      },
    );

    const outbound = JSON.parse(socket.sent[0] ?? '{}') as { taskId: string };
    router.handleProviderMessage(session.sessionId, {
      type: 'task_progress',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 1,
      progress: 0.5,
      message: 'Fetching weather data',
    });
    router.handleProviderMessage(session.sessionId, {
      type: 'task_chunk',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 2,
      data: 'partial-output',
    });
    router.handleProviderMessage(session.sessionId, {
      type: 'task_result',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 3,
      result: { done: true },
    });

    await responsePromise;

    expect(events).toEqual([
      { type: 'progress', taskId: outbound.taskId, sequence: 1, progress: 0.5, message: 'Fetching weather data' },
      { type: 'chunk', taskId: outbound.taskId, sequence: 2, data: 'partial-output' },
      { type: 'result', taskId: outbound.taskId, sequence: 3, result: { done: true } },
    ]);
  });

  it('rejects replayed or out-of-order provider messages', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const provider = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });

    const responsePromise = router.routeTask({
      requesterDid: createAuthMessage([]).did,
      providerDid: provider.did,
      capability: 'weather',
      input: {},
    });

    const outbound = JSON.parse(socket.sent[0] ?? '{}') as { taskId: string };
    router.handleProviderMessage(session.sessionId, {
      type: 'task_progress',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 1,
      progress: 0.25,
    });

    expect(() =>
      router.handleProviderMessage(session.sessionId, {
        type: 'task_chunk',
        sessionId: session.sessionId,
        taskId: outbound.taskId,
        sequence: 1,
        data: 'duplicate',
      }),
    ).toThrowError(/Out-of-order relay message rejected/);

    router.handleProviderMessage(session.sessionId, {
      type: 'task_result',
      sessionId: session.sessionId,
      taskId: outbound.taskId,
      sequence: 2,
      result: { ok: true },
    });

    await expect(responsePromise).resolves.toMatchObject({ result: { ok: true } });
  });

  it('rejects active tasks when the relay shuts down', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const provider = createAuthMessage(['weather']);
    manager.registerSession(new TestSocket() as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });

    const responsePromise = router.routeTask({
      requesterDid: createAuthMessage([]).did,
      providerDid: provider.did,
      capability: 'weather',
      input: {},
    });

    router.close();

    await expect(responsePromise).rejects.toMatchObject({ code: 'RELAY_SHUTDOWN' satisfies RelayRouteError['code'] });
  });

  it('routes the same request to multiple providers concurrently', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const firstSocket = new TestSocket();
    const secondSocket = new TestSocket();
    const firstProvider = createAuthMessage(['weather']);
    const secondProvider = createAuthMessage(['weather']);
    const firstSession = manager.registerSession(firstSocket as unknown as WebSocket, firstProvider.authMessage);
    const secondSession = manager.registerSession(secondSocket as unknown as WebSocket, secondProvider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });

    const responsePromise = router.routeMulti({
      requesterDid: createAuthMessage([]).did,
      capability: 'weather',
      input: { location: 'Paris' },
    }, [firstProvider.did, secondProvider.did]);

    const firstOutbound = JSON.parse(firstSocket.sent[0] ?? '{}') as { taskId: string };
    const secondOutbound = JSON.parse(secondSocket.sent[0] ?? '{}') as { taskId: string };
    router.handleProviderMessage(firstSession.sessionId, {
      type: 'task_result',
      sessionId: firstSession.sessionId,
      taskId: firstOutbound.taskId,
      sequence: 1,
      result: { provider: firstProvider.did },
    });
    router.handleProviderMessage(secondSession.sessionId, {
      type: 'task_result',
      sessionId: secondSession.sessionId,
      taskId: secondOutbound.taskId,
      sequence: 1,
      result: { provider: secondProvider.did },
    });

    await expect(responsePromise).resolves.toEqual([
      {
        taskId: firstOutbound.taskId,
        providerDid: firstProvider.did,
        sequence: 1,
        result: { provider: firstProvider.did },
      },
      {
        taskId: secondOutbound.taskId,
        providerDid: secondProvider.did,
        sequence: 1,
        result: { provider: secondProvider.did },
      },
    ]);
  });

  it('does not disconnect the provider when a streaming consumer drops mid-task', async () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const provider = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, provider.authMessage);
    const router = new RelayRouter({ sessionManager: manager, taskTimeoutMs: 1_000 });

    const responsePromise = router.routeStreamingTask(
      {
        requesterDid: createAuthMessage([]).did,
        providerDid: provider.did,
        capability: 'weather',
        input: { location: 'Boston' },
      },
      () => {
        throw new Error('consumer disconnected');
      },
    );

    const outbound = JSON.parse(socket.sent[0] ?? '{}') as { taskId: string };
    expect(() =>
      router.handleProviderMessage(session.sessionId, {
        type: 'task_progress',
        sessionId: session.sessionId,
        taskId: outbound.taskId,
        sequence: 1,
        progress: 0.5,
      }),
    ).not.toThrow();

    await expect(responsePromise).rejects.toMatchObject({
      code: 'STREAM_DELIVERY_FAILED' satisfies RelayRouteError['code'],
    });
    expect(manager.getSession(session.sessionId)).not.toBeNull();
  });
});
