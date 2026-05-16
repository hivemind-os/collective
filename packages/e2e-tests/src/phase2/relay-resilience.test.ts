import WebSocket, { type RawData } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { RelayClient } from '@hivemind-os/collective-daemon/relay';
import { createAuthPayload, parseRelayMessage } from '@hivemind-os/collective-relay';
import { PaymentRail } from '@hivemind-os/collective-types';

import { createArtifactRoot, removeDirectoryWithRetries, waitForCondition } from '../phase1/test-helpers.js';
import {
  buildSuiPaymentHeaders,
  connectTestProvider,
  createTestIdentity,
  postRelayExecute,
  readHealth,
  startTestRelay,
} from './test-helpers.js';

let artifactRoot: string;

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
});

describe('Phase 2 E2E: Relay Resilience', () => {
  it('provider auto-reconnects after relay restart', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-relay-resilience');
    const initialRelay = await startTestRelay({
      artifactRoot,
      name: 'reconnect-initial',
      limits: {
        heartbeatIntervalMs: 200,
        heartbeatTimeoutMs: 800,
      },
    });
    const provider = createTestIdentity();
    const client = new RelayClient(
      {
        relayUrl: initialRelay.wsUrl,
        reconnectIntervalMs: 100,
        heartbeatIntervalMs: 200,
      },
      provider.authProvider,
    );

    try {
      await client.connect(['echo']);
      await waitForCondition(async () => {
        const health = await readHealth(initialRelay.httpUrl);
        return health.connectedProviders === 1 ? health : undefined;
      }, 5_000, 'Relay did not observe the connected provider.');

      await initialRelay.stop();
      await waitForCondition(async () => (!client.isConnected ? true : undefined), 5_000, 'Relay client never disconnected.');

      const restartedRelay = await startTestRelay({
        artifactRoot,
        name: 'reconnect-restarted',
        port: initialRelay.port,
        limits: {
          heartbeatIntervalMs: 200,
          heartbeatTimeoutMs: 800,
        },
      });
      try {
        await waitForCondition(async () => (client.isConnected ? true : undefined), 10_000, 'Relay client never reconnected.');
        await waitForCondition(async () => {
          const health = await readHealth(restartedRelay.httpUrl);
          return health.connectedProviders === 1 ? health : undefined;
        }, 10_000, 'Restarted relay never saw the provider reconnect.');
      } finally {
        await client.disconnect().catch(() => undefined);
        await restartedRelay.stop();
      }
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }, 30_000);

  it('task timeout returns a timeout error to the consumer', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-relay-resilience');
    const relayServer = await startTestRelay({
      artifactRoot,
      name: 'timeout',
      limits: {
        taskTimeoutMs: 300,
      },
    });
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
    });
    const requester = createTestIdentity();

    try {
      const challengeResponse = await postRelayExecute({
        httpUrl: relayServer.httpUrl,
        providerDid: provider.identity.did,
        capability: 'echo',
        requesterDid: requester.did,
        paymentRail: PaymentRail.SUI_TRANSFER,
        input: 'hang forever',
      });
      const challengeBody = (await challengeResponse.json()) as { payment: Parameters<typeof buildSuiPaymentHeaders>[1] };
      const paymentHeaders = await buildSuiPaymentHeaders(requester, challengeBody.payment);

      const startedAt = Date.now();
      const timedOutResponse = await postRelayExecute({
        httpUrl: relayServer.httpUrl,
        providerDid: provider.identity.did,
        capability: 'echo',
        requesterDid: requester.did,
        paymentRail: PaymentRail.SUI_TRANSFER,
        input: 'hang forever',
        headers: paymentHeaders,
      });
      const body = (await timedOutResponse.json()) as { error: { code: string; message: string } };

      expect(timedOutResponse.status).toBe(504);
      expect(body.error.code).toBe('TASK_TIMEOUT');
      expect(body.error.message).toContain('timed out');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    } finally {
      await provider.close().catch(() => undefined);
      await relayServer.stop();
    }
  });

  it('replay protection rejects duplicate provider sequence numbers', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-relay-resilience');
    const relayServer = await startTestRelay({ artifactRoot, name: 'replay' });
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendProgress(message.taskId, 0.1, 'first-progress', 1);
        await connection.sendProgress(message.taskId, 0.2, 'duplicate-progress', 1);
      },
    });
    const requester = createTestIdentity();

    try {
      await expect(
        relayServer.relay.router.routeTask({
          requesterDid: requester.did,
          capability: 'echo',
          input: { replay: true },
          providerDid: provider.identity.did,
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow(/Provider disconnected|timed out/i);

      const closeInfo = await provider.waitForClose();
      expect(closeInfo.code).toBe(4008);
      expect(closeInfo.reason).toMatch(/Provider message rejected|Out-of-order/i);
    } finally {
      await provider.close().catch(() => undefined);
      await relayServer.stop();
    }
  });

  it('invalid auth causes the relay to reject the connection', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-relay-resilience');
    const relayServer = await startTestRelay({ artifactRoot, name: 'invalid-auth' });
    const identity = createTestIdentity();
    const socket = new WebSocket(relayServer.wsUrl);

    try {
      const result = await new Promise<{ message: { type: string; reason?: string }; code: number }>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for invalid-auth rejection.')), 5_000);
        let authFail: { type: string; reason?: string } | undefined;

        socket.once('open', () => {
          socket.send(
            JSON.stringify({
              type: 'auth',
              did: identity.did,
              nonce: 'invalid-auth',
              signature: '00',
              capabilities: ['echo'],
              payload: createAuthPayload({ did: identity.did, nonce: 'invalid-auth', capabilities: ['echo'] }),
            }),
          );
        });
        socket.on('message', (payload: RawData) => {
          const parsed = parseRelayMessage(normalizePayload(payload));
          if (parsed?.type === 'auth_fail') {
            authFail = parsed;
          }
        });
        socket.once('close', (code: number) => {
          clearTimeout(timeout);
          resolvePromise({
            message: authFail ?? { type: 'auth_fail' },
            code,
          });
        });
      });

      expect(result.message.type).toBe('auth_fail');
      expect(result.message.reason).toMatch(/Invalid provider authentication signature/i);
      expect(result.code).toBe(4006);
    } finally {
      socket.close();
      await relayServer.stop();
    }
  });

  it('rate limiting returns 429 for excessive requests', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-relay-resilience');
    const relayServer = await startTestRelay({
      artifactRoot,
      name: 'rate-limit',
      limits: {
        maxRequestsPerSecond: 1,
      },
    });

    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${relayServer.httpUrl}/health`)));
      const statuses = responses.map((response) => response.status);

      expect(statuses).toContain(429);
      expect(statuses).toContain(200);
    } finally {
      await relayServer.stop();
    }
  });
});

function normalizePayload(payload: RawData): string | Buffer | ArrayBuffer | Buffer[] {
  if (typeof payload === 'string' || payload instanceof ArrayBuffer || Array.isArray(payload)) {
    return payload;
  }

  return Buffer.from(payload);
}
