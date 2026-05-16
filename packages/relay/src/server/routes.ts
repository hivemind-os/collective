import { encodePaymentResponseHeader } from '@x402/core/http';
import { PaymentRail, type DID } from '@hivemind-os/collective-types';
import type { FastifyInstance } from 'fastify';

import type { RelayConfig } from '../config.js';
import { HealthMonitor } from '../health/monitor.js';
import { PaymentGate } from '../payment/payment-gate.js';
import type { RelayRegistryRuntime } from '../registry/relay-registry-service.js';
import { RelayRouteError, RelayRouter } from '../routing/router.js';
import { SessionManager } from '../routing/session-manager.js';
import { applyMeshResponseHeaders, getMeshRequestContext } from './middleware.js';

export interface RelayRouteDependencies {
  relayDid: DID;
  version: string;
  config: RelayConfig;
  sessionManager: SessionManager;
  router: RelayRouter;
  paymentGate: PaymentGate;
  healthMonitor: HealthMonitor;
  relayRegistry?: RelayRegistryRuntime;
}

const CONSUMER_SEQUENCE_TTL_MS = 60 * 60_000;

interface ConsumerSequenceState {
  sequence: number;
  updatedAt: number;
}

export async function registerRelayRoutes(app: FastifyInstance, deps: RelayRouteDependencies): Promise<void> {
  const consumerSequences = new Map<string, ConsumerSequenceState>();

  app.get('/health', async () => {
    const status = deps.healthMonitor.getStatus();
    return {
      status: status.status === 'healthy' ? 'ok' : status.status,
      relayStatus: status.status,
      uptime: status.uptime,
      connectedProviders: status.connectedProviders,
      activeRequests: status.activeRequests,
      totalRequestsServed: status.totalRequestsServed,
      averageLatencyMs: status.averageLatencyMs,
      relayRegistry: deps.relayRegistry?.getInfo() ?? { enabled: false, registered: false },
    };
  });

  app.get('/info', async () => ({
    relayDid: deps.relayDid,
    version: deps.version,
    feeSchedule: {
      basePercentage: deps.config.fees.basePercentage,
      minimumMist: deps.config.fees.minimumMist.toString(),
    },
    capabilities: [...new Set(deps.sessionManager.getConnectedProviders().flatMap((provider) => provider.capabilities))].sort(),
    relayRegistry: deps.relayRegistry?.getInfo() ?? { enabled: false, registered: false },
  }));

  app.post('/mesh/providers/:providerDid/capabilities/:capability/execute', async (request, reply) => {
    const tracker = deps.healthMonitor.beginRequest();
    const context = getMeshRequestContext(request);
    applyMeshResponseHeaders(reply, deps.relayDid, context.requestId);

    try {
      const params = request.params as { providerDid: DID; capability: string };
      const sequenceError = validateConsumerSequence(consumerSequences, context, Date.now());
      if (sequenceError) {
        reply.code(sequenceError.statusCode).send(toError(sequenceError.code, sequenceError.message, context.requestId));
        return;
      }

      if (!context.requesterDid) {
        reply.code(400).send(toError('REQUESTER_REQUIRED', 'X-Mesh-Requester header is required.', context.requestId));
        return;
      }

      const provider = deps.sessionManager.findProvider(params.capability, params.providerDid);
      if (!provider) {
        reply.code(404).send(
          toError('PROVIDER_NOT_FOUND', `Provider ${params.providerDid} is not connected to the relay.`, context.requestId),
        );
        return;
      }

      const paymentRail = context.paymentRail ?? defaultPaymentRailForProvider(provider, deps.paymentGate);
      if (!context.paymentSignature) {
        const challenge = deps.paymentGate.generate402Challenge(paymentRail, params.capability, provider);
        reply
          .code(402)
          .header('PAYMENT-REQUIRED', challenge.extra?.['payment-required'] ?? '')
          .send({
            ...toError('PAYMENT_REQUIRED', 'Payment is required before relay execution.', context.requestId),
            payment: challenge,
          });
        return;
      }

      const challenge = context.paymentNonce ? deps.paymentGate.getChallenge(context.paymentNonce) : null;
      if (!challenge) {
        reply.code(400).send(
          toError('PAYMENT_CHALLENGE_REQUIRED', 'X-Mesh-Payment-Nonce must reference an active challenge.', context.requestId),
        );
        return;
      }

      const verification = await deps.paymentGate.verifyPayment(context.paymentSignature, challenge);
      if (!verification.accepted) {
        reply.code(402).send({
          ...toError('PAYMENT_REJECTED', verification.reason ?? 'Payment verification failed.', context.requestId),
          payment: challenge,
        });
        return;
      }

      if (!deps.sessionManager.getSession(provider.sessionId)) {
        reply.code(503).send(
          toError(
            'PROVIDER_UNAVAILABLE',
            `Provider ${params.providerDid} disconnected before the relay could start the task. No funds were settled.`,
            context.requestId,
            true,
          ),
        );
        return;
      }

      if (isStreamingRequest(request)) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-mesh-provider': provider.providerDid,
          'x-mesh-request-id': context.requestId,
          'x-mesh-relay': deps.relayDid,
          'payment-response': verification.settlementReference ?? '',
        });

        try {
          const routed = await deps.router.routeStreamingTask(
            {
              requesterDid: context.requesterDid,
              providerDid: params.providerDid,
              capability: params.capability,
              input: request.body,
              timeoutMs: deps.config.limits.taskTimeoutMs,
            },
            (event) => {
              if (event.type === 'result') {
                return;
              }
              writeSse(reply.raw, event.type, event);
            },
          );

          await deps.relayRegistry?.recordRouting(BigInt(challenge.relayFee));
          writeSse(reply.raw, 'result', {
            taskId: routed.taskId,
            providerDid: routed.providerDid,
            result: routed.result,
            paymentReceipt: verification.settlementReference,
            relayFeeMist: challenge.relayFee,
          });
        } catch (error) {
          const routeError = error instanceof RelayRouteError ? error : new RelayRouteError('ROUTE_FAILED', 'Relay routing failed.', 502, true);
          writeSse(reply.raw, 'error', { code: routeError.code, message: routeError.message });
        } finally {
          reply.raw.end();
        }
        return;
      }

      const response = await deps.router.routeTask({
        requesterDid: context.requesterDid,
        providerDid: params.providerDid,
        capability: params.capability,
        input: request.body,
        timeoutMs: deps.config.limits.taskTimeoutMs,
      });

      await deps.relayRegistry?.recordRouting(BigInt(challenge.relayFee));
      reply
        .code(200)
        .header('X-Mesh-Provider', response.providerDid)
        .header('X-Mesh-Response-Id', response.taskId)
        .header('X-Mesh-Relay-Fee', challenge.relayFee)
        .header(
          'PAYMENT-RESPONSE',
          verification.settlementReference ??
            encodePaymentResponseHeader({
              success: true,
              transaction: `relay-${response.taskId}`,
              network: toSettlementNetwork(challenge.network),
              amount: challenge.amount,
              payer: verification.payer,
            }),
        )
        .send(response.result);
    } catch (error) {
      const routeError = error instanceof RelayRouteError ? error : new RelayRouteError('ROUTE_FAILED', 'Relay routing failed.', 502, true);
      reply.code(routeError.statusCode).send(toError(routeError.code, routeError.message, context.requestId, routeError.retryable));
    } finally {
      tracker.finish();
    }
  });
}

function validateConsumerSequence(
  sequences: Map<string, ConsumerSequenceState>,
  context: ReturnType<typeof getMeshRequestContext>,
  now: number,
) {
  pruneConsumerSequences(sequences, now);

  if (!context.sessionId && context.sequence === undefined) {
    return null;
  }

  if (!context.sessionId || context.sequence === undefined) {
    return {
      code: 'SEQUENCE_REQUIRED',
      message: 'X-Mesh-Session-Id and X-Mesh-Sequence must be provided together.',
      statusCode: 400,
    };
  }

  const previous = sequences.get(context.sessionId)?.sequence ?? 0;
  if (context.sequence <= previous) {
    return {
      code: 'REPLAY_DETECTED',
      message: 'Relay rejected a replayed or out-of-order consumer request.',
      statusCode: 409,
    };
  }

  sequences.set(context.sessionId, { sequence: context.sequence, updatedAt: now });
  return null;
}

function pruneConsumerSequences(sequences: Map<string, ConsumerSequenceState>, now: number): void {
  for (const [sessionId, state] of sequences.entries()) {
    if (now - state.updatedAt <= CONSUMER_SEQUENCE_TTL_MS) {
      continue;
    }

    sequences.delete(sessionId);
  }
}

function defaultPaymentRailForProvider(provider: { capabilities: string[] }, paymentGate: PaymentGate): PaymentRail {
  return paymentGate.defaultRail ?? PaymentRail.SUI_TRANSFER;
}

function isStreamingRequest(request: { headers: Record<string, unknown>; query: unknown }): boolean {
  const accept = typeof request.headers.accept === 'string' ? request.headers.accept : '';
  if (accept.includes('text/event-stream')) {
    return true;
  }

  if (typeof request.query !== 'object' || request.query === null) {
    return false;
  }

  const query = request.query as Record<string, unknown>;
  return query.stream === '1' || query.stream === 'true';
}

function writeSse(stream: NodeJS.WritableStream, event: string, data: unknown): void {
  stream.write(`event: ${event}\n`);
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}

function toError(code: string, message: string, requestId: string, retryable = false) {
  return {
    error: {
      code,
      message,
      details: {},
      retryable,
      retryAfterMs: retryable ? 1_000 : null,
      requestId,
    },
  };
}

function toSettlementNetwork(network: string): `${string}:${string}` {
  switch (network) {
    case 'base':
      return 'eip155:8453';
    case 'base-sepolia':
      return 'eip155:84532';
    case 'sui-mainnet':
      return 'sui:mainnet';
    case 'sui-testnet':
      return 'sui:testnet';
    case 'sui-devnet':
      return 'sui:devnet';
    default:
      return network.includes(':') ? (network as `${string}:${string}`) : 'sui:testnet';
  }
}
