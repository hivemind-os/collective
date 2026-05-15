import type { SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { BidStatus, MarketplaceClient, TaskStatus, type MeshSuiClient } from '../src/index.js';

const networkConfig = {
  rpcUrl: 'http://127.0.0.1:9000',
  faucetUrl: 'http://127.0.0.1:9123',
  packageId: '0x1',
  registryId: '0x2',
};

function getCommands(tx: { getData: () => { commands: Array<Record<string, unknown>> } }): Array<Record<string, unknown>> {
  return tx.getData().commands;
}

function createBidPlacedEvent(payload: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: '0xtx', eventSeq: '0' },
    packageId: networkConfig.packageId,
    transactionModule: 'marketplace',
    type: `${networkConfig.packageId}::marketplace::BidPlaced`,
    sender: '0xbidder',
    timestampMs: '1000',
    parsedJson: payload,
    bcs: '',
    bcsEncoding: 'base64',
  } as unknown as SuiEvent;
}

function createTaskPostedEvent(payload: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: '0xtask', eventSeq: '0' },
    packageId: networkConfig.packageId,
    transactionModule: 'task',
    type: `${networkConfig.packageId}::task::TaskPosted`,
    sender: '0xrequester',
    timestampMs: '1000',
    parsedJson: payload,
    bcs: '',
    bcsEncoding: 'base64',
  } as unknown as SuiEvent;
}

describe('MarketplaceClient', () => {
  it('places bids with explicit reputation scores', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({
      digest: '0xtx',
      objectChanges: [
        {
          type: 'created',
          objectType: '0x1::marketplace::Bid',
          objectId: '0xb01',
        },
      ],
    });
    const client = new MarketplaceClient(
      {
        executeTransaction,
        getObject: vi.fn(),
        queryEvents: vi.fn(),
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const result = await client.placeBid({
      taskId: '0xa01',
      bidPriceMist: 500n,
      reputationScore: 88n,
      evidenceBlob: 'proposal',
      signer: {} as unknown as Ed25519Keypair,
    });

    const commands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    expect(commands[0]?.$kind).toBe('MoveCall');
    expect(result).toEqual({ bidId: '0xb01', txDigest: '0xtx', reputationScore: 88n });
  });

  it('accepts bids and rejects competing active bids in the same transaction', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({ digest: '0xaccept' });
    const queryEvents = vi.fn().mockResolvedValue({
      events: [
        createBidPlacedEvent({ bid_id: '0xb11', task_id: '0xa11' }),
        createBidPlacedEvent({ bid_id: '0xb12', task_id: '0xa11' }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    const getObject = vi.fn(async (objectId: string) => {
      if (objectId === '0xb11') {
        return {
          id: '0xb11',
          task_id: '0xa11',
          bidder: '0xprovider1',
          bid_price: '600',
          reputation_score: '40',
          evidence_blob: 'first',
          created_at: 1_000,
          status: BidStatus.ACTIVE,
        };
      }
      return {
        id: '0xb12',
        task_id: '0xa11',
        bidder: '0xprovider2',
        bid_price: '500',
        reputation_score: '80',
        evidence_blob: 'second',
        created_at: 1_100,
        status: BidStatus.ACTIVE,
      };
    });
    const client = new MarketplaceClient(
      {
        executeTransaction,
        getObject,
        queryEvents,
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const result = await client.acceptBid({
      taskId: '0xa11',
      bidId: '0xb12',
      signer: {} as unknown as Ed25519Keypair,
    });

    const commands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    expect(commands).toHaveLength(2);
    expect(result).toEqual({ txDigest: '0xaccept', rejectedBidIds: ['0xb11'] });
  });

  it('accepts a bid without rejecting competitors when requested', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({ digest: '0xaccept' });
    const client = new MarketplaceClient(
      {
        executeTransaction,
        getObject: vi.fn(),
        queryEvents: vi.fn(),
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const result = await client.acceptBid({
      taskId: '0xa11',
      bidId: '0xb12',
      rejectCompeting: false,
      signer: {} as unknown as Ed25519Keypair,
    });

    const commands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    expect(commands).toHaveLength(1);
    expect(result).toEqual({ txDigest: '0xaccept', rejectedBidIds: [] });
  });

  it('parses bids for a task and ranks the recommended bid', async () => {
    const queryEvents = vi.fn().mockResolvedValue({
      events: [
        createBidPlacedEvent({ bid_id: '0xb21', task_id: '0xa21' }),
        createBidPlacedEvent({ bid_id: '0xb22', task_id: '0xa21' }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    const getObject = vi.fn(async (objectId: string) => {
      if (objectId === '0xb21') {
        return {
          id: '0xb21',
          task_id: '0xa21',
          bidder: '0xprovider1',
          bid_price: '700',
          reputation_score: '100',
          evidence_blob: 'strong reputation',
          created_at: 1_000,
          status: BidStatus.ACTIVE,
        };
      }
      return {
        id: '0xb22',
        task_id: '0xa21',
        bidder: '0xprovider2',
        bid_price: '500',
        reputation_score: '50',
        evidence_blob: 'cheaper',
        created_at: 1_100,
        status: BidStatus.ACTIVE,
      };
    });
    const client = new MarketplaceClient(
      {
        executeTransaction: vi.fn(),
        getObject,
        queryEvents,
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const bids = await client.getBidsForTask('0xa21');
    const recommended = await client.getRecommendedBid('0xa21', { reputationWeight: 20n, priceWeight: 1n });

    expect(bids).toHaveLength(2);
    expect(bids[0]?.evidenceBlob).toBe('strong reputation');
    expect(recommended?.bid.id).toBe('0xb21');
    expect(recommended?.score).toBeGreaterThan(0n);
  });

  it('rejects invalid browse filters and negative recommendation weights', async () => {
    const client = new MarketplaceClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn(async () => ({
          id: '0xb21',
          task_id: '0xa21',
          bidder: '0xprovider1',
          bid_price: '700',
          reputation_score: '100',
          evidence_blob: 'strong reputation',
          created_at: 1_000,
          status: BidStatus.ACTIVE,
        })),
        queryEvents: vi.fn().mockResolvedValue({
          events: [createBidPlacedEvent({ bid_id: '0xb21', task_id: '0xa21' })],
          nextCursor: null,
          hasMore: false,
        }),
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(client.browseOpenTasks({ limit: Number.NaN })).rejects.toThrow('filters.limit must be a positive safe integer.');
    await expect(client.browseOpenTasks({ minPriceMist: 10n, maxPriceMist: 5n })).rejects.toThrow(
      'filters.minPriceMist must be less than or equal to filters.maxPriceMist.',
    );
    await expect(client.getRecommendedBid('0xa21', { reputationWeight: -1n })).rejects.toThrow('options.reputationWeight must be non-negative.');
  });

  it('browses only open tasks that match category filters', async () => {
    const queryEvents = vi.fn().mockResolvedValue({
      events: [
        createTaskPostedEvent({
          task_id: '0xaa1',
          requester: '0xrequester',
          provider: '0x0',
          capability: 'summarize',
          category: 'analysis',
          input_blob_id: 'blob-1',
          agreement_hash: 'hash-1',
          price: '500',
          status: TaskStatus.OPEN,
          dispute_window_ms: 60_000,
          expires_at: Date.now() + 10_000,
          created_at: 1_000,
        }),
        createTaskPostedEvent({
          task_id: '0xaa2',
          requester: '0xrequester',
          provider: '0x0',
          capability: 'code',
          category: 'code',
          input_blob_id: 'blob-2',
          agreement_hash: 'hash-2',
          price: '700',
          status: TaskStatus.OPEN,
          dispute_window_ms: 60_000,
          expires_at: Date.now() + 10_000,
          created_at: 2_000,
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    const getObject = vi.fn(async (objectId: string) => ({
      id: objectId,
      requester: '0xrequester',
      provider: '0x0',
      capability: objectId === '0xaa1' ? 'summarize' : 'code',
      category: objectId === '0xaa1' ? 'analysis' : 'code',
      input_blob_id: objectId === '0xaa1' ? 'blob-1' : 'blob-2',
      agreement_hash: objectId === '0xaa1' ? 'hash-1' : 'hash-2',
      price: objectId === '0xaa1' ? '500' : '700',
      status: objectId === '0xaa1' ? TaskStatus.OPEN : TaskStatus.ACCEPTED,
      dispute_window_ms: 60_000,
      created_at: objectId === '0xaa1' ? 1_000 : 2_000,
      expires_at: Date.now() + 10_000,
    }));
    const client = new MarketplaceClient(
      {
        executeTransaction: vi.fn(),
        getObject,
        queryEvents,
        client: { getOwnedObjects: vi.fn() },
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const tasks = await client.browseOpenTasks({ category: 'analysis', maxPriceMist: 600n });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('0xaa1');
    expect(tasks[0]?.category).toBe('analysis');
  });
});
