import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PaymentRail, BidStatus, DisputeStatus, TaskStatus, type AgentCard, type Bid, type Dispute, type Task } from '@agentic-mesh/types';

import { IndexerStore, encodeCursor } from '../src/store.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'indexer.sqlite');
}

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
        description: 'Summarize content',
        version: '1.0.0',
        pricing: { rail: PaymentRail.SUI_ESCROW, amount: 100n, currency: 'MIST' },
      },
    ],
    endpoint: 'https://example.com',
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 2_000,
    totalTasksCompleted: 3,
    totalTasksFailed: 1,
    totalTasksDisputed: 1,
    totalEarningsMist: 1_000n,
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '0xtask-1',
    requester: '0xrequester',
    provider: '0xowner-1',
    capability: 'summarize',
    category: 'analysis',
    inputBlobId: 'blob:input',
    price: 500n,
    status: TaskStatus.OPEN,
    disputeWindowMs: 5_000,
    createdAt: 10_000,
    expiresAt: 20_000,
    ...overrides,
  };
}

function createBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: '0xbid-1',
    taskId: '0xtask-1',
    bidder: '0xowner-1',
    bidPrice: 400n,
    reputationScore: 10n,
    createdAt: 11_000,
    status: BidStatus.ACTIVE,
    ...overrides,
  };
}

function createDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: '0xdispute-1',
    taskId: '0xtask-1',
    requester: '0xrequester',
    provider: '0xowner-1',
    escrowAmount: 500n,
    status: DisputeStatus.OPEN,
    requesterEvidenceBlob: 'blob:req',
    requesterProposedSplit: 100n,
    providerProposedSplit: 0n,
    rulingSplit: 0n,
    openedAt: 13_000,
    resolutionDeadline: 18_000,
    ...overrides,
  };
}

describe('IndexerStore', () => {
  it('stores agents and supports advanced agent queries', async () => {
    const store = new IndexerStore(await createDbPath());
    store.upsertAgent(createAgent());
    store.upsertStake({ stakeId: '0xstake-1', owner: '0xowner-1', amountMist: 10_000n, stakeType: 'agent', active: true });
    store.upsertTask(createTask(), '0xtx-1', 20n);

    const matches = store.queryAgents({ capability: 'summarize', category: 'analysis', minReputation: 0.7, sortBy: 'reputation' });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.hasStake).toBe(true);
    store.close();
  });

  it('stores task history, bids, disputes, and cursors', async () => {
    const store = new IndexerStore(await createDbPath());
    store.upsertTask(createTask(), '0xtx-posted', 10n);
    store.updateTaskStatus({
      taskId: '0xtask-1',
      status: TaskStatus.ACCEPTED,
      txDigest: '0xtx-accepted',
      timestampMs: 12_000,
      provider: '0xowner-1',
      eventType: 'task.accepted',
      payload: { taskId: '0xtask-1' },
    });
    store.upsertBid(createBid());
    store.updateBidStatus('0xbid-1', BidStatus.ACCEPTED, 12_500);
    store.upsertDispute(createDispute());
    store.setCursor('event:test', { txDigest: '0xtx', eventSeq: '2' });

    const task = store.getTask('0xtask-1');
    expect(task?.status).toBe(TaskStatus.ACCEPTED);
    expect(task?.transitions).toHaveLength(2);
    expect(task?.bidCount).toBe(1);
    expect(encodeCursor(task!)).toBeTruthy();
    expect(store.getBids('0xtask-1', BidStatus.ACCEPTED)).toHaveLength(1);
    expect(store.getDisputes({ status: DisputeStatus.OPEN })).toHaveLength(1);
    expect(store.getCursor('event:test')).toEqual({ txDigest: '0xtx', eventSeq: '2' });
    store.close();
  });
});
