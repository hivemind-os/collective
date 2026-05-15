import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PaymentScheme, SqliteCursorStore, TaskStatus, parseRawEvent } from '../src/index.js';

const createdPaths: string[] = [];
const packageId = '0xpackage';

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'cursor.sqlite');
}

describe('event parsing', () => {
  it('parses AgentRegistered events', () => {
    const event = parseRawEvent(
      {
        id: { txDigest: '0xtx', eventSeq: '0' },
        packageId,
        transactionModule: 'registry',
        type: `${packageId}::registry::AgentRegistered`,
        sender: '0xowner',
        timestampMs: '1000',
        parsedJson: {
          card_id: '0xcard',
          agent: '0xowner',
          did: 'did:mesh:test',
          name: 'Agent One',
          description: 'Helpful agent',
          capabilities: [
            {
              name: 'summarize',
              description: 'Summarizes text',
              version: '1.0.0',
              price_mist: '100',
              currency: 'MIST',
            },
          ],
          endpoint: 'https://example.com',
          active: true,
          version: 1,
          registered_at: 1000,
          updated_at: 1000,
        },
        bcs: '',
        bcsEncoding: 'base64',
      },
      packageId,
    );

    expect(event?.type).toBe('agent.registered');
    if (event?.type !== 'agent.registered') {
      throw new Error('Unexpected event type');
    }
    expect(event.agent.id).toBe('0xcard');
    expect(event.agent.capabilities[0]?.name).toBe('summarize');
  });

  it('parses TaskPosted events', () => {
    const event = parseRawEvent(
      {
        id: { txDigest: '0xtask', eventSeq: '1' },
        packageId,
        transactionModule: 'task',
        type: `${packageId}::task::TaskPosted`,
        sender: '0xrequester',
        timestampMs: '2000',
        parsedJson: {
          task_id: '0xtask-id',
          requester: '0xrequester',
          provider: '0x0',
          capability: 'summarize',
          category: 'analysis',
          input_blob_id: [105, 110, 112, 117, 116],
          agreement_hash: [104, 97, 115, 104],
          price: '1000',
          status: 0,
          dispute_window_ms: 5000,
          expires_at: 10000,
          created_at: 2000,
        },
        bcs: '',
        bcsEncoding: 'base64',
      },
      packageId,
    );

    expect(event?.type).toBe('task.posted');
    if (event?.type !== 'task.posted') {
      throw new Error('Unexpected event type');
    }
    expect(event.task.id).toBe('0xtask-id');
    expect(event.task.category).toBe('analysis');
    expect(event.task.inputBlobId).toBe('input');
    expect(event.task.status).toBe(TaskStatus.OPEN);
  });

  it('parses metered completion and release events', () => {
    const completed = parseRawEvent(
      {
        id: { txDigest: '0xcomplete', eventSeq: '2' },
        packageId,
        transactionModule: 'task',
        type: `${packageId}::task::TaskCompleted`,
        sender: '0xprovider',
        timestampMs: '3000',
        parsedJson: {
          task_id: '0xtask-id',
          provider: '0xprovider',
          result_blob_id: [114, 101, 115, 117, 108, 116],
          payment_scheme: 1,
          metered_units: 2,
          verification_hash: Array.from(Buffer.from('aa'.repeat(32), 'hex')),
          completed_at: 3000,
        },
        bcs: '',
        bcsEncoding: 'base64',
      },
      packageId,
    );
    const released = parseRawEvent(
      {
        id: { txDigest: '0xrelease', eventSeq: '3' },
        packageId,
        transactionModule: 'task',
        type: `${packageId}::task::TaskPaymentReleased`,
        sender: '0xrequester',
        timestampMs: '4000',
        parsedJson: {
          task_id: '0xtask-id',
          requester: '0xrequester',
          provider: '0xprovider',
          refund_amount: '7',
        },
        bcs: '',
        bcsEncoding: 'base64',
      },
      packageId,
    );

    expect(completed?.type).toBe('task.completed');
    if (completed?.type !== 'task.completed') {
      throw new Error('Unexpected event type');
    }
    expect(completed.paymentScheme).toBe(PaymentScheme.UPTO);
    expect(completed.meteredUnits).toBe(2);
    expect(completed.verificationHash).toBe('aa'.repeat(32));

    expect(released?.type).toBe('task.released');
    if (released?.type !== 'task.released') {
      throw new Error('Unexpected event type');
    }
    expect(released.refundAmount).toBe(7n);
  });

  it('returns null for unknown event types', () => {
    const event = parseRawEvent(
      {
        id: { txDigest: '0xunknown', eventSeq: '0' },
        packageId,
        transactionModule: 'misc',
        type: `${packageId}::misc::Unknown`,
        sender: '0xsender',
        timestampMs: '0',
        parsedJson: {},
        bcs: '',
        bcsEncoding: 'base64',
      },
      packageId,
    );

    expect(event).toBeNull();
  });
});

describe('SqliteCursorStore', () => {
  it('round-trips stored cursors', async () => {
    const store = new SqliteCursorStore(await createDbPath());
    const cursor = { txDigest: '0xtx', eventSeq: '7' };

    await store.setCursor('event-type', cursor);
    await expect(store.getCursor('event-type')).resolves.toEqual(cursor);
    store.close();
  });

  it('returns null for unknown event types', async () => {
    const store = new SqliteCursorStore(await createDbPath());
    await expect(store.getCursor('missing')).resolves.toBeNull();
    store.close();
  });
});
