import { createMeteredResultEnvelope, serializeMeteredResultEnvelope, UsageMeter } from '@hivemind-os/collective-core';
import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, PaymentScheme, TaskStatus, type AgentCard } from '@hivemind-os/collective-types';

import { runMeshMeteredExecute, runMeshVerifyResult } from '../src/tools/metering.js';

function createAgent(): AgentCard {
  return {
    id: 'agent-1',
    owner: 'owner',
    did: 'did:mesh:provider' as AgentCard['did'],
    name: 'Provider',
    description: 'Test provider',
    active: true,
    version: 1,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
    endpoint: 'mesh://agent/provider',
    capabilities: [
      {
        name: 'echo',
        description: 'Echo capability',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 5n,
          currency: 'MIST',
        },
        executionMode: 'async',
        paymentRails: [PaymentRail.SUI_ESCROW],
      },
    ],
  };
}

function createMeteredBlob(result: string) {
  const resultBytes = new TextEncoder().encode(result);
  const meter = new UsageMeter({ taskId: 'task-1', maxPrice: 10n, unitPrice: 2n });
  meter.recordUnit(resultBytes);
  return serializeMeteredResultEnvelope(createMeteredResultEnvelope(resultBytes, meter.getProof(), resultBytes.length));
}

function createContext(agent: AgentCard) {
  const resultBlob = createMeteredBlob('verified-result');
  return {
    keypair: {} as never,
    blobStore: {
      store: vi.fn(async () => ({ blobId: 'blob-in' })),
      fetch: vi.fn(async () => resultBlob),
    },
    taskClient: {
      postMeteredTask: vi.fn(async () => ({ taskId: 'task-1' })),
      getTask: vi.fn(async () => ({
        id: 'task-1',
        requester: '0xrequester',
        provider: '0xprovider',
        capability: 'echo',
        category: 'general',
        inputBlobId: 'blob-in',
        resultBlobId: 'blob-out',
        price: 2n,
        paymentScheme: PaymentScheme.UPTO,
        maxPrice: 10n,
        meteredUnits: 1,
        unitPrice: 2n,
        verificationHash: new UsageMeter({ taskId: 'task-1', maxPrice: 10n, unitPrice: 2n }).getVerificationHash(),
        status: TaskStatus.COMPLETED,
        disputeWindowMs: 1,
        createdAt: 1,
        expiresAt: 2,
        agreementHash: 'metered:echo',
      })),
      releaseMeteredPayment: vi.fn(async () => undefined),
    },
    agentCache: {
      searchByCapability: vi.fn(() => [agent]),
      getAgentByDID: vi.fn((did: string) => (did === agent.did ? agent : undefined)),
      upsertAgent: vi.fn(),
    },
    registryClient: {
      discoverByCapability: vi.fn(async () => []),
      getAgentCardByOwner: vi.fn(async () => null),
    },
    spendingPolicy: {
      evaluate: vi.fn(() => ({ approved: true })),
      record: vi.fn(),
    },
    relayAuthProvider: undefined,
    x402Client: undefined,
    logger: {
      warn: vi.fn(),
    },
    blob: resultBlob,
  };
}

describe('metering tools', () => {
  it('executes a metered task and verifies the result', async () => {
    const agent = createAgent();
    const context = createContext(agent);
    const resultBytes = new TextEncoder().encode('verified-result');
    const meter = new UsageMeter({ taskId: 'task-1', maxPrice: 10n, unitPrice: 2n });
    meter.recordUnit(resultBytes);
    (context.taskClient.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'task-1',
      requester: '0xrequester',
      provider: '0xprovider',
      capability: 'echo',
      category: 'general',
      inputBlobId: 'blob-in',
      resultBlobId: 'blob-out',
      price: 2n,
      paymentScheme: PaymentScheme.UPTO,
      maxPrice: 10n,
      meteredUnits: 1,
      unitPrice: 2n,
      verificationHash: meter.getVerificationHash(),
      status: TaskStatus.COMPLETED,
      disputeWindowMs: 1,
      createdAt: 1,
      expiresAt: 2,
      agreementHash: 'metered:echo',
    });

    const result = await runMeshMeteredExecute({
      capability: 'echo',
      input: 'hello',
      max_price_mist: 10,
      unit_price_mist: 2,
    }, context as never);

    expect(result.task_id).toBe('task-1');
    expect(result.verified).toBe(true);
    expect(result.result).toBe('verified-result');
    expect(context.taskClient.postMeteredTask).toHaveBeenCalledOnce();
    expect(context.taskClient.releaseMeteredPayment).toHaveBeenCalledOnce();
  });

  it('verifies stored metered results', async () => {
    const agent = createAgent();
    const context = createContext(agent);
    const resultBytes = new TextEncoder().encode('verified-result');
    const meter = new UsageMeter({ taskId: 'task-1', maxPrice: 10n, unitPrice: 2n });
    meter.recordUnit(resultBytes);
    (context.taskClient.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'task-1',
      requester: '0xrequester',
      provider: '0xprovider',
      capability: 'echo',
      category: 'general',
      inputBlobId: 'blob-in',
      resultBlobId: 'blob-out',
      price: 2n,
      paymentScheme: PaymentScheme.UPTO,
      maxPrice: 10n,
      meteredUnits: 1,
      unitPrice: 2n,
      verificationHash: meter.getVerificationHash(),
      status: TaskStatus.COMPLETED,
      disputeWindowMs: 1,
      createdAt: 1,
      expiresAt: 2,
      agreementHash: 'metered:echo',
    });

    const result = await runMeshVerifyResult({ task_id: 'task-1' }, context as never);

    expect(result.verified).toBe(true);
    expect(result.result).toBe('verified-result');
    expect(result.metered_units).toBe(1);
  });
});
