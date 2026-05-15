import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, type AgentCard } from '@agentic-mesh/types';

import type { MeshToolContext } from '../src/context.js';
import { runMeshDiscover } from '../src/tools/discover.js';

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xowner-1',
    did: 'did:mesh:agent-1' as AgentCard['did'],
    name: 'Summarizer',
    description: 'Summarizes text',
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarize documents',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 100n,
          currency: 'MIST',
        },
      },
    ],
    endpoint: 'mesh://agent/did:mesh:agent-1',
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createContext(overrides: Partial<MeshToolContext> = {}): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {} as MeshToolContext['keypair'],
    suiClient: {
      getBalance: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as MeshToolContext['suiClient'],
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
    spendingPolicy: {} as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    ...overrides,
  };
}

describe('runMeshDiscover', () => {
  it('returns matching agents from cache', async () => {
    const agent = createAgent();
    const context = createContext({
      agentCache: {
        searchByCapability: vi.fn().mockReturnValue([agent]),
        getAgentByDID: vi.fn(),
        getAllActive: vi.fn().mockReturnValue([agent]),
        upsertAgent: vi.fn(),
        removeAgent: vi.fn(),
      } as unknown as MeshToolContext['agentCache'],
    });

    const result = await runMeshDiscover({ capability: 'summarize' }, context);

    expect(result.source).toBe('cache');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ name: 'Summarizer', did: 'did:mesh:agent-1' });
    expect(result.agents[0].reputation.total_tasks).toBe(0);
    expect(context.registryClient.discoverByCapability).not.toHaveBeenCalled();
  });

  it('uses the indexer when configured', async () => {
    const context = createContext({
      indexer: {
        graphqlUrl: 'http://localhost:4000/graphql',
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              agents: {
                nodes: [
                  {
                    id: '0xagent-1',
                    owner: '0xowner-1',
                    did: 'did:mesh:agent-1',
                    name: 'Summarizer',
                    description: 'Summarizes text',
                    endpoint: 'mesh://agent/did:mesh:agent-1',
                    active: true,
                    version: 1,
                    registeredAt: '1000',
                    updatedAt: '1000',
                    totalTasksCompleted: 5,
                    totalTasksFailed: 1,
                    totalTasksDisputed: 0,
                    totalEarningsMist: '1000',
                    hasStake: true,
                    stakeMist: '100',
                    stakeType: 'agent',
                    capabilities: [
                      {
                        name: 'summarize',
                        description: 'Summarize documents',
                        version: '1.0.0',
                        executionMode: 'sync',
                        paymentRails: ['sui-escrow'],
                        pricing: { rail: 'sui-escrow', amount: '100', currency: 'MIST' },
                      },
                    ],
                  },
                ],
              },
            },
          }),
        }) as unknown as typeof fetch,
      },
    });

    const result = await runMeshDiscover({ capability: 'summarize' }, context);

    expect(result.source).toBe('indexer');
    expect(result.agents[0]?.reputation.total_tasks).toBe(6);
    expect(context.registryClient.discoverByCapability).not.toHaveBeenCalled();
  });

  it('falls back to sui discovery when cache is empty', async () => {
    const agent = createAgent();
    const context = createContext({
      registryClient: {
        discoverByCapability: vi.fn().mockResolvedValue([agent]),
        getAgentCard: vi.fn(),
      } as unknown as MeshToolContext['registryClient'],
    });

    const result = await runMeshDiscover({ capability: 'summarize' }, context);

    expect(result.source).toBe('registry');
    expect(result.agents).toHaveLength(1);
    expect(context.registryClient.discoverByCapability).toHaveBeenCalledWith('summarize', 10, { sortByReputation: false });
    expect(context.agentCache.upsertAgent).toHaveBeenCalledWith(agent);
  });

  it('sorts by reputation when requested', async () => {
    const stronger = createAgent({ totalTasksCompleted: 10, totalTasksFailed: 1 });
    const weaker = createAgent({ id: '0xagent-2', did: 'did:mesh:agent-2' as AgentCard['did'], totalTasksCompleted: 1, totalTasksFailed: 3 });
    const context = createContext({
      agentCache: {
        searchByCapability: vi.fn().mockImplementation((_capability, _limit, options?: { sortByReputation?: boolean }) => (
          options?.sortByReputation ? [stronger, weaker] : [weaker, stronger]
        )),
        getAgentByDID: vi.fn(),
        getAllActive: vi.fn().mockReturnValue([weaker, stronger]),
        upsertAgent: vi.fn(),
        removeAgent: vi.fn(),
      } as unknown as MeshToolContext['agentCache'],
    });

    const result = await runMeshDiscover({ capability: 'summarize', sort_by: 'reputation' }, context);

    expect(result.agents.map((agent) => agent.did)).toEqual([stronger.did, weaker.did]);
  });

  it('respects the limit parameter', async () => {
    const context = createContext({
      agentCache: {
        searchByCapability: vi.fn().mockReturnValue([
          createAgent(),
          createAgent({ id: '0xagent-2', did: 'did:mesh:agent-2' as AgentCard['did'] }),
        ]),
        getAgentByDID: vi.fn(),
        getAllActive: vi.fn().mockReturnValue([]),
        upsertAgent: vi.fn(),
        removeAgent: vi.fn(),
      } as unknown as MeshToolContext['agentCache'],
    });

    const result = await runMeshDiscover({ capability: 'summarize', limit: 1 }, context);

    expect(result.agents).toHaveLength(1);
  });

  it('returns an empty array when no matches exist', async () => {
    const context = createContext();

    const result = await runMeshDiscover({ capability: 'summarize' }, context);

    expect(result.agents).toEqual([]);
  });
});
