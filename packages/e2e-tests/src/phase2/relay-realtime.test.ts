import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RelayConsumerClient } from '@agentic-mesh/core';
import { PaymentRail, type DID } from '@agentic-mesh/types';
import type { PaymentChallenge } from '@agentic-mesh/relay';

import { createArtifactRoot, removeDirectoryWithRetries, waitForCondition } from '../phase1/test-helpers.js';
import {
  buildSuiPaymentHeaders,
  connectTestProvider,
  createTestIdentity,
  postRelayExecute,
  readHealth,
  startTestRelay,
  type StartedRelay,
  type TestProviderConnection,
} from './test-helpers.js';

let artifactRoot: string;
let relayServer: StartedRelay;
const activeProviders: TestProviderConnection[] = [];

beforeAll(async () => {
  artifactRoot = await createArtifactRoot('phase2-relay-realtime');
  relayServer = await startTestRelay({
    artifactRoot,
    name: 'realtime',
    limits: {
      taskTimeoutMs: 2_000,
    },
  });
}, 30_000);

afterEach(async () => {
  while (activeProviders.length > 0) {
    await activeProviders.pop()?.close().catch(() => undefined);
  }

  await waitForCondition(async () => {
    const health = await readHealth(relayServer.httpUrl);
    return health.connectedProviders === 0 ? health : undefined;
  }, 5_000, 'Relay still had connected providers after test cleanup.').catch(() => undefined);
});

afterAll(async () => {
  await relayServer?.stop();
  await removeDirectoryWithRetries(artifactRoot);
}, 30_000);

describe('Phase 2 E2E: Relay Real-time Task Flow', () => {
  it('provider connects to relay via WebSocket and registers capabilities', async () => {
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo', 'translate'],
    });
    activeProviders.push(provider);

    await waitForCondition(async () => {
      const session = relayServer.relay.sessionManager.getSession(provider.sessionId);
      return session ? session : undefined;
    }, 5_000, 'Provider relay session was not registered.');

    const health = await readHealth(relayServer.httpUrl);
    expect(provider.sessionId).toBeTruthy();
    expect(health.connectedProviders).toBe(1);
    expect(relayServer.relay.sessionManager.findProvider('echo', provider.identity.did)?.providerDid).toBe(provider.identity.did);
  });

  it('consumer executes sync task via relay HTTP endpoint', async () => {
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, {
          echo: (message.input as { message: string }).message,
          capability: message.capability,
          handledBy: connection.identity.did,
        });
      },
    });
    activeProviders.push(provider);

    const consumer = createTestIdentity();
    const challengeResponse = await postRelayExecute({
      httpUrl: relayServer.httpUrl,
      providerDid: provider.identity.did,
      capability: 'echo',
      requesterDid: consumer.did,
      paymentRail: PaymentRail.SUI_TRANSFER,
      input: { message: 'hello relay' },
    });

    expect(challengeResponse.status).toBe(402);
    const challengeBody = (await challengeResponse.json()) as { payment: PaymentChallenge };
    const paymentHeaders = await buildSuiPaymentHeaders(consumer, challengeBody.payment);

    const paidResponse = await postRelayExecute({
      httpUrl: relayServer.httpUrl,
      providerDid: provider.identity.did,
      capability: 'echo',
      requesterDid: consumer.did,
      paymentRail: PaymentRail.SUI_TRANSFER,
      input: { message: 'hello relay' },
      headers: paymentHeaders,
    });

    const paidBody = (await paidResponse.json()) as { echo: string; capability: string; handledBy: DID };
    expect(paidResponse.status).toBe(200);
    expect(paidBody).toEqual({
      echo: 'hello relay',
      capability: 'echo',
      handledBy: provider.identity.did,
    });
    expect(paidResponse.headers.get('x-mesh-provider')).toBe(provider.identity.did);
    expect(paidResponse.headers.get('x-mesh-response-id')).toBeTruthy();
  });

  it('provider handles echo task via relay', async () => {
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, {
          echo: message.input,
          capability: message.capability,
          format: 'relay-echo',
        });
      },
    });
    activeProviders.push(provider);

    const consumer = createTestIdentity();
    const client = new RelayConsumerClient(null, consumer.authProvider, { relayUrl: relayServer.httpUrl });
    const result = await client.executeSync({
      providerDid: provider.identity.did,
      capability: 'echo',
      input: 'Phase 2 relay echo',
      paymentRail: PaymentRail.SUI_TRANSFER,
      timeoutMs: 2_000,
    });

    expect(result.result).toEqual({
      echo: 'Phase 2 relay echo',
      capability: 'echo',
      format: 'relay-echo',
    });
    expect(provider.receivedTasks).toHaveLength(1);
    expect(provider.receivedTasks[0]?.requesterDid).toBe(consumer.did);
  });

  it('streaming: provider sends progressive chunks', async () => {
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendProgress(message.taskId, 0.25, 'started');
        await connection.sendChunk(message.taskId, 'Hello ');
        await connection.sendProgress(message.taskId, 0.75, 'almost-done');
        await connection.sendChunk(message.taskId, 'relay');
        await connection.sendResult(message.taskId, { combined: 'Hello relay', streamed: true });
      },
    });
    activeProviders.push(provider);

    const consumer = createTestIdentity();
    const client = new RelayConsumerClient(null, consumer.authProvider, { relayUrl: relayServer.httpUrl });
    const chunks: string[] = [];
    const progress: Array<{ value: number; message?: string }> = [];

    const result = await client.executeSyncStreaming({
      providerDid: provider.identity.did,
      capability: 'echo',
      input: { mode: 'stream' },
      paymentRail: PaymentRail.SUI_TRANSFER,
      timeoutMs: 2_000,
      onChunk: (chunk) => chunks.push(chunk),
      onProgress: (value, message) => progress.push({ value, message }),
    });

    expect(chunks).toEqual(['Hello ', 'relay']);
    expect(progress).toEqual([
      { value: 0.25, message: 'started' },
      { value: 0.75, message: 'almost-done' },
    ]);
    expect(result.result).toEqual({ combined: 'Hello relay', streamed: true });
  });

  it('provider disconnects and consumer gets an unavailable error', async () => {
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
    });
    activeProviders.push(provider);

    await provider.close(1000, 'disconnect-before-request');
    await waitForCondition(async () => {
      const health = await readHealth(relayServer.httpUrl);
      return health.connectedProviders === 0 ? health : undefined;
    }, 5_000, 'Relay did not observe the provider disconnect.');

    const consumer = createTestIdentity();
    const client = new RelayConsumerClient(null, consumer.authProvider, { relayUrl: relayServer.httpUrl });
    await expect(
      client.executeSync({
        providerDid: provider.identity.did,
        capability: 'echo',
        input: 'after disconnect',
        paymentRail: PaymentRail.SUI_TRANSFER,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(provider.identity.did);
  });

  it('relay health endpoint reflects connection state', async () => {
    const initialHealth = await readHealth(relayServer.httpUrl);
    expect(initialHealth.connectedProviders).toBe(0);

    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
    });
    activeProviders.push(provider);

    await waitForCondition(async () => {
      const health = await readHealth(relayServer.httpUrl);
      return health.connectedProviders === 1 ? health : undefined;
    }, 5_000, 'Relay health never reflected the connected provider.');

    const connectedHealth = await readHealth(relayServer.httpUrl);
    expect(connectedHealth.connectedProviders).toBe(1);
    expect(connectedHealth.status).toBe('ok');
  });

  it('multiple providers route to the correct target DID', async () => {
    const providerA = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { provider: 'A' });
      },
    });
    const providerB = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { provider: 'B' });
      },
    });
    activeProviders.push(providerA, providerB);

    const consumer = createTestIdentity();
    const client = new RelayConsumerClient(null, consumer.authProvider, { relayUrl: relayServer.httpUrl });
    const result = await client.executeSync({
      providerDid: providerB.identity.did,
      capability: 'echo',
      input: 'route by did',
      paymentRail: PaymentRail.SUI_TRANSFER,
      timeoutMs: 2_000,
    });

    expect(result.result).toEqual({ provider: 'B' });
    expect(providerA.receivedTasks).toHaveLength(0);
    expect(providerB.receivedTasks).toHaveLength(1);
  });

  it('multiple providers route by capability when no DID is specified', async () => {
    const echoProvider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { routedTo: 'echo' });
      },
    });
    const translateProvider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['translate'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { routedTo: 'translate' });
      },
    });
    activeProviders.push(echoProvider, translateProvider);

    const consumer = createTestIdentity();
    const response = await relayServer.relay.router.routeTask({
      requesterDid: consumer.did,
      capability: 'echo',
      input: { value: 'pick echo' },
      timeoutMs: 2_000,
    });

    expect(response.providerDid).toBe(echoProvider.identity.did);
    expect(response.result).toEqual({ routedTo: 'echo' });
    expect(echoProvider.receivedTasks).toHaveLength(1);
    expect(translateProvider.receivedTasks).toHaveLength(0);
  });
});
