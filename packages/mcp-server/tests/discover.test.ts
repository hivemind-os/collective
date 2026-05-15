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

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ name: 'Summarizer', did: 'did:mesh:agent-1' });
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

    expect(result.agents).toHaveLength(1);
    expect(context.registryClient.discoverByCapability).toHaveBeenCalledWith('summarize', 10);
    expect(context.agentCache.upsertAgent).toHaveBeenCalledWith(agent);
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
