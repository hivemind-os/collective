import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, ProviderSelectionStrategy, type AgentCard } from '@agentic-mesh/types';

const runMeshExecuteMock = vi.fn();
const discoverAgentsByCapabilityMock = vi.fn();

vi.mock('../src/tools/discover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/discover.js')>();
  return {
    ...actual,
    discoverAgentsByCapability: (...args: unknown[]) => discoverAgentsByCapabilityMock(...args),
  };
});

vi.mock('../src/tools/execute.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/execute.js')>();
  return {
    ...actual,
    runMeshExecute: (...args: unknown[]) => runMeshExecuteMock(...args),
  };
});

import type { MeshToolContext } from '../src/context.js';
import { runMeshMultiExecute } from '../src/tools/multi-execute.js';

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: 'agent-1',
    owner: 'owner-1',
    did: 'did:mesh:agent-1' as AgentCard['did'],
    name: 'Agent 1',
    description: 'Test agent',
    capabilities: [
      {
        name: 'echo',
        description: 'Echo',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 5n,
          currency: 'MIST',
        },
      },
    ],
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createContext(): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {} as MeshToolContext['keypair'],
    suiClient: {} as MeshToolContext['suiClient'],
    registryClient: {
      discoverByCapability: vi.fn().mockResolvedValue([]),
      getAgentCard: vi.fn(),
    } as unknown as MeshToolContext['registryClient'],
    taskClient: {} as MeshToolContext['taskClient'],
    agentCache: {
      searchByCapability: vi.fn().mockReturnValue([]),
      getAgentByDID: vi.fn(),
      getAllActive: vi.fn().mockReturnValue([]),
      upsertAgent: vi.fn(),
      removeAgent: vi.fn(),
    } as unknown as MeshToolContext['agentCache'],
    blobStore: {} as MeshToolContext['blobStore'],
    spendingPolicy: {
      evaluate: vi.fn(() => ({ approved: true })),
      record: vi.fn(),
    } as unknown as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
  };
}

describe('runMeshMultiExecute', () => {
  it('selects multiple providers and aggregates the first successful result', async () => {
    runMeshExecuteMock.mockImplementation(async (params: { provider_did?: string }) => ({
      task_id: `task-${params.provider_did}`,
      result: params.provider_did === 'did:mesh:agent-1' ? 'winner' : 'runner-up',
      provider_did: params.provider_did ?? 'unknown',
      price_mist: params.provider_did === 'did:mesh:agent-1' ? '5' : '7',
      status: 'COMPLETED',
      execution_mode: 'sync',
      payment_rail: PaymentRail.SUI_ESCROW,
    }));
    const agents = [
      createAgent(),
      createAgent({ id: 'agent-2', did: 'did:mesh:agent-2' as AgentCard['did'], totalTasksCompleted: 10, capabilities: [{
        name: 'echo',
        description: 'Echo',
        version: '1.0.0',
        pricing: { rail: PaymentRail.SUI_ESCROW, amount: 7n, currency: 'MIST' },
      }] }),
    ];

    discoverAgentsByCapabilityMock.mockResolvedValueOnce({
      agents,
      source: 'cache',
    });

    const result = await runMeshMultiExecute({
      capability: 'echo',
      input: { message: 'hello' },
      fanOutCount: 2,
      strategy: ProviderSelectionStrategy.CHEAPEST,
    }, createContext());

    expect(result.providers).toHaveLength(2);
    expect(result.aggregated_result).toBe('winner');
    expect(result.total_cost_mist).toBe('12');
    expect(runMeshExecuteMock).toHaveBeenCalledTimes(2);
  });
});
