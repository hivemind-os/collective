import { describe, expect, it, vi } from 'vitest';

import type { MeshToolContext } from '../src/context.js';
import { runMeshAnalytics } from '../src/tools/analytics.js';

function createContext(): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {} as MeshToolContext['keypair'],
    suiClient: {} as MeshToolContext['suiClient'],
    registryClient: {} as MeshToolContext['registryClient'],
    taskClient: {} as MeshToolContext['taskClient'],
    agentCache: {} as MeshToolContext['agentCache'],
    blobStore: {} as MeshToolContext['blobStore'],
    spendingPolicy: {} as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    indexer: {
      graphqlUrl: 'http://localhost:4000/graphql',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { analytics: { totalTasks: 3 } } }),
      }) as unknown as typeof fetch,
    },
  };
}

describe('runMeshAnalytics', () => {
  it('queries analytics summary from the indexer', async () => {
    const context = createContext();

    const result = await runMeshAnalytics({ view: 'summary' }, context);

    expect(result).toEqual({ view: 'summary', data: { totalTasks: 3 } });
    expect(context.indexer?.fetch).toHaveBeenCalled();
  });
});
