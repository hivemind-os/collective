import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskStatus, DisputeStatus } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';

import { MeshIndexer } from '../src/indexer.js';
import { IndexerStore } from '../src/store.js';

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

function createEvent(type: string, eventSeq: string, parsedJson: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: `0xtx-${eventSeq}`, eventSeq },
    packageId: '0xpackage',
    transactionModule: type.split('::')[1] ?? 'task',
    type,
    sender: '0xsender',
    timestampMs: '1000',
    parsedJson,
    bcs: '',
    bcsEncoding: 'base64',
  } as unknown as SuiEvent;
}

describe('MeshIndexer', () => {
  it('processes task and dispute events and persists cursors', async () => {
    const store = new IndexerStore(await createDbPath());
    const taskEvent = createEvent('0xpackage::task::TaskPosted', '1', {
      task_id: '0xtask-1',
      requester: '0xrequester',
      provider: '0xprovider',
      capability: 'summarize',
      category: 'analysis',
      input_blob_id: 'blob:input',
      price: '500',
      status: TaskStatus.OPEN,
      dispute_window_ms: 5000,
      created_at: 1000,
      expires_at: 2000,
    });
    const disputeEvent = createEvent('0xpackage::dispute::DisputeOpened', '2', {
      dispute_id: '0xdispute-1',
      task_id: '0xtask-1',
      requester: '0xrequester',
      provider: '0xprovider',
      escrow_amount: '500',
    });

    const queryEvents = vi.fn().mockImplementation(async (eventType: string) => {
      if (eventType.endsWith('TaskPosted')) {
        return { events: [taskEvent], nextCursor: null, hasMore: false };
      }
      if (eventType.endsWith('DisputeOpened')) {
        return { events: [disputeEvent], nextCursor: null, hasMore: false };
      }
      return { events: [], nextCursor: null, hasMore: false };
    });
    const getTransactionBlock = vi.fn().mockResolvedValue({
      checkpoint: '7',
      effects: { gasUsed: { computationCost: '2', storageCost: '3', storageRebate: '1', nonRefundableStorageFee: '0' } },
    });
    const getObject = vi.fn().mockResolvedValue({
      task_id: '0xtask-1',
      requester: '0xrequester',
      provider: '0xprovider',
      escrow_amount: '500',
      status: DisputeStatus.OPEN,
      requester_evidence_blob: 'blob:req',
      requester_proposed_split: '100',
      provider_proposed_split: '0',
      ruling_split: '0',
      opened_at: 1000,
      resolution_deadline: 2000,
    });

    const indexer = new MeshIndexer({
      suiClient: {
        queryEvents,
        getObject,
        client: { getTransactionBlock },
      } as never,
      store,
      packageId: '0xpackage',
      pollIntervalMs: 10,
    });

    const processed = await indexer.pollOnce();

    expect(processed).toBeGreaterThan(0);
    expect(store.getTask('0xtask-1')?.status).toBe(TaskStatus.OPEN);
    expect(store.getDisputes({ status: DisputeStatus.OPEN })).toHaveLength(1);
    expect(store.getCursor('event:0xpackage::task::TaskPosted')).toEqual({ txDigest: '0xtx-1', eventSeq: '1' });
    store.close();
  });
});
