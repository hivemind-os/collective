import { describe, expect, it, vi } from 'vitest';

import type { MeshToolContext } from '../src/context.js';
import { runMeshMarketplaceAcceptBid } from '../src/tools/marketplace-accept-bid.js';
import { runMeshMarketplaceBid } from '../src/tools/marketplace-bid.js';
import { runMeshMarketplaceBrowse } from '../src/tools/marketplace-browse.js';
import { runMeshMarketplacePost } from '../src/tools/marketplace-post.js';

function createContext(overrides: Partial<MeshToolContext> = {}): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {
      getPublicKey: () => ({
        toSuiAddress: () => '0xabc',
      }),
    } as MeshToolContext['keypair'],
    suiClient: {
      getBalance: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as MeshToolContext['suiClient'],
    registryClient: {} as MeshToolContext['registryClient'],
    taskClient: {} as MeshToolContext['taskClient'],
    agentCache: {} as MeshToolContext['agentCache'],
    blobStore: {
      store: vi.fn(async () => ({ blobId: 'walrus:input' })),
      fetch: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
    } as unknown as MeshToolContext['blobStore'],
    spendingPolicy: {} as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    marketplaceClient: {
      postOpenTask: vi.fn(),
      browseOpenTasks: vi.fn(),
      placeBid: vi.fn(),
      acceptBid: vi.fn(),
    } as unknown as MeshToolContext['marketplaceClient'],
    ...overrides,
  };
}

describe('marketplace MCP tools', () => {
  it('posts marketplace tasks and uploads inline input', async () => {
    const context = createContext();
    vi.mocked(context.marketplaceClient?.postOpenTask as never).mockResolvedValue({ taskId: '0xtask', txDigest: '0xtx' });

    const result = await runMeshMarketplacePost({
      capability: 'summarize',
      category: 'analysis',
      price_mist: '500',
      input: 'hello world',
    }, context);

    expect(context.blobStore.store).toHaveBeenCalledOnce();
    expect(context.marketplaceClient?.postOpenTask).toHaveBeenCalledWith({
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'walrus:input',
      agreementHash: undefined,
      priceMist: 500n,
      disputeWindowMs: 60_000,
      expiryHours: 24,
      signer: context.keypair,
    });
    expect(result).toMatchObject({ task_id: '0xtask', tx_digest: '0xtx' });
  });

  it('browses marketplace tasks with filters', async () => {
    const context = createContext();
    vi.mocked(context.marketplaceClient?.browseOpenTasks as never).mockResolvedValue([{ id: '0xtask', category: 'analysis' }]);

    const result = await runMeshMarketplaceBrowse({ category: 'analysis', max_price_mist: '750', limit: 5 }, context);

    expect(context.marketplaceClient?.browseOpenTasks).toHaveBeenCalledWith({
      category: 'analysis',
      minPriceMist: undefined,
      maxPriceMist: 750n,
      limit: 5,
    });
    expect(result).toMatchObject({ count: 1 });
  });

  it('rejects conflicting marketplace input sources', async () => {
    const context = createContext();

    await expect(runMeshMarketplacePost({
      capability: 'summarize',
      category: 'analysis',
      price_mist: '500',
      input: 'hello world',
      input_blob_id: 'walrus:input',
    }, context)).rejects.toThrow('Provide exactly one of input or input_blob_id when posting a marketplace task');
  });

  it('places and accepts bids', async () => {
    const context = createContext();
    vi.mocked(context.marketplaceClient?.placeBid as never).mockResolvedValue({ bidId: '0xbid', txDigest: '0xbidtx', reputationScore: 99n });
    vi.mocked(context.marketplaceClient?.acceptBid as never).mockResolvedValue({ txDigest: '0xaccept', rejectedBidIds: ['0xbid-2'] });

    await expect(runMeshMarketplaceBid({ task_id: '0xtask', bid_price_mist: '400', evidence: 'proposal' }, context)).resolves.toMatchObject({
      bid_id: '0xbid',
      tx_digest: '0xbidtx',
      reputation_score: '99',
    });

    await expect(runMeshMarketplaceAcceptBid({ task_id: '0xtask', bid_id: '0xbid' }, context)).resolves.toMatchObject({
      bid_id: '0xbid',
      rejected_bid_ids: ['0xbid-2'],
      tx_digest: '0xaccept',
    });
  });
});
