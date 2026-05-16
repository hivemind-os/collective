import { randomUUID } from 'node:crypto';

import { PaymentRail, type DID } from '@hivemind-os/collective-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isValidDID } from '@hivemind-os/collective-core';

export interface MeshRequestContext {
  requestId: string;
  requesterDid?: DID;
  targetProviderDid?: DID;
  timestamp?: string;
  signature?: string;
  paymentSignature?: string;
  paymentNonce?: string;
  paymentRail?: PaymentRail;
  sessionId?: string;
  sequence?: number;
}

export function registerMeshMiddleware(app: FastifyInstance, relayDid: string): void {
  app.addHook('onRequest', async (request, reply) => {
    const requesterDid = request.headers['x-mesh-requester'];
    const targetProvider = request.headers['x-mesh-target-provider'];

    if (typeof requesterDid === 'string' && requesterDid.length > 0 && !isValidDID(requesterDid)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_REQUESTER_DID',
          message: 'X-Mesh-Requester must be a valid did:mesh identifier.',
        },
      });
      return;
    }

    if (typeof targetProvider === 'string' && targetProvider.length > 0 && !isValidDID(targetProvider)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_TARGET_PROVIDER_DID',
          message: 'X-Mesh-Target-Provider must be a valid did:mesh identifier.',
        },
      });
      return;
    }

    reply.header('X-Mesh-Relay', relayDid);
  });
}

export function getMeshRequestContext(request: FastifyRequest): MeshRequestContext {
  return {
    requestId: readHeader(request, 'x-mesh-request-id') ?? randomUUID(),
    requesterDid: readHeader(request, 'x-mesh-requester') as DID | undefined,
    targetProviderDid: readHeader(request, 'x-mesh-target-provider') as DID | undefined,
    timestamp: readHeader(request, 'x-mesh-timestamp'),
    signature: readHeader(request, 'x-mesh-signature'),
    paymentSignature: readHeader(request, 'payment-signature') ?? readHeader(request, 'x-payment-signature'),
    paymentNonce: readHeader(request, 'x-mesh-payment-nonce'),
    paymentRail: normalizePaymentRail(readHeader(request, 'x-mesh-payment-rail')),
    sessionId: readHeader(request, 'x-mesh-session-id'),
    sequence: readPositiveInteger(readHeader(request, 'x-mesh-sequence')),
  };
}

export function applyMeshResponseHeaders(reply: FastifyReply, relayDid: string, requestId: string): void {
  reply.header('X-Mesh-Relay', relayDid);
  reply.header('X-Mesh-Request-Id', requestId);
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  return Number(value);
}

function normalizePaymentRail(value: string | undefined): PaymentRail | undefined {
  if (value === PaymentRail.SUI_ESCROW || value === PaymentRail.SUI_TRANSFER || value === PaymentRail.X402_BASE) {
    return value;
  }

  return undefined;
}
