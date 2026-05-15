import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, TaskStatus, type AgentCard } from '@agentic-mesh/types';

const relayExecuteMock = vi.fn();

vi.mock('@agentic-mesh/core', () => ({
  PaymentRailSelector: class {
    selectRail() {
      return 'x402-base';
    }
  },
  RelayConsumerClient: class {
    async executeSync(...args: unknown[]) {
      return relayExecuteMock(...args);
    }
  },
}));

import { runMeshExecute } from '../src/tools/execute.js';

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
    relayEndpoints: [{ endpoint: 'https://relay.example', modes: ['sync', 'fallback'] }],
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
        executionMode: 'sync',
        paymentRails: [PaymentRail.X402_BASE, PaymentRail.SUI_TRANSFER, PaymentRail.SUI_ESCROW],
      },
    ],
  };
}

function createContext(agent: AgentCard) {
  return {
    keypair: {} as never,
    blobStore: {
      store: vi.fn(async () => ({ blobId: 'blob-in' })),
      fetch: vi.fn(async () => new TextEncoder().encode('async-result')),
    },
    taskClient: {
      postTask: vi.fn(async () => ({ taskId: 'task-1' })),
      getTask: vi.fn(async () => ({ status: TaskStatus.COMPLETED, resultBlobId: 'blob-out' })),
      releasePayment: vi.fn(async () => undefined),
    },
    agentCache: {
      searchByCapability: vi.fn(() => [agent]),
      getAgentByDID: vi.fn((did: string) => (did === agent.did ? agent : undefined)),
      upsertAgent: vi.fn(),
    },
    registryClient: {
      discoverByCapability: vi.fn(async () => []),
    },
    meshClient: {} as never,
    spendingPolicy: {
      evaluate: vi.fn(() => ({ approved: true })),
      record: vi.fn(),
    },
    networkConfig: {} as never,
    relayAuthProvider: {} as never,
    x402Client: {} as never,
    logger: {
      warn: vi.fn(),
    },
  };
}

describe('runMeshExecute', () => {
  it('returns relay sync results when relay execution succeeds', async () => {
    relayExecuteMock.mockResolvedValueOnce({
      result: { ok: true },
      paymentReceipt: 'receipt-1',
      latencyMs: 12,
      taskId: 'relay-task-1',
      providerDid: 'did:mesh:provider',
    });
    const agent = createAgent();
    const context = createContext(agent);

    const result = await runMeshExecute({ capability: 'echo', input: 'hello', mode: 'sync' }, context as never);

    expect(result.execution_mode).toBe('sync');
    expect(result.task_id).toBe('relay-task-1');
    expect(result.result).toBe(JSON.stringify({ ok: true }));
    expect(result.payment_rail).toBe(PaymentRail.X402_BASE);
    expect(context.taskClient.postTask).not.toHaveBeenCalled();
  });

  it('falls back to async execution when relay sync is unavailable', async () => {
    relayExecuteMock.mockRejectedValueOnce(new Error('fetch failed'));
    const agent = createAgent();
    const context = createContext(agent);

    const result = await runMeshExecute({ capability: 'echo', input: 'hello' }, context as never);

    expect(result.execution_mode).toBe('async');
    expect(result.task_id).toBe('task-1');
    expect(result.result).toBe('async-result');
    expect(result.payment_rail).toBe(PaymentRail.SUI_ESCROW);
    expect(context.taskClient.postTask).toHaveBeenCalledOnce();
    expect(context.taskClient.releasePayment).toHaveBeenCalledOnce();
    expect(context.logger.warn).toHaveBeenCalledOnce();
  });
});
