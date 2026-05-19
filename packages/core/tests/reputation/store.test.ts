import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReputationEvent } from '@hivemind-os/collective-types';

import { ReputationStore } from '../../src/index.js';

const createdPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'reputation.sqlite');
}

function createEvent(overrides: Partial<ReputationEvent> = {}): ReputationEvent {
  return {
    eventId: 'event-1',
    type: 'task_completion',
    subject: 'did:mesh:provider',
    author: 'did:mesh:requester',
    taskId: 'task-1',
    outcome: 'success',
    capability: 'echo',
    timestamp: new Date(1_700_000_000_000).toISOString(),
    nonce: 'nonce-1',
    signature: 'signature-1',
    ...overrides,
  };
}

describe('ReputationStore', () => {
  it('skips malformed stored events when querying', async () => {
    const store = new ReputationStore(await createDbPath());
    const valid = createEvent();

    await store.addEvent(valid);
    const db = (store as unknown as { db: Database.Database }).db;
    db.prepare(
      `INSERT INTO reputation_events (
        event_id, type, subject, author, task_id, outcome, capability,
        timestamp, timestamp_ms, nonce, signature, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'corrupt-event',
      'task_completion',
      'did:mesh:provider',
      'did:mesh:requester',
      'task-corrupt',
      'success',
      'echo',
      valid.timestamp,
      Date.parse(valid.timestamp),
      'nonce-corrupt',
      'signature-corrupt',
      '{"subject":"did:mesh:provider"}',
      Date.now(),
    );

    const events = await store.getEvents({ subject: 'did:mesh:provider' });
    expect(events).toEqual([valid]);
    store.close();
  });

  it('stores, queries, and anchors events', async () => {
    const store = new ReputationStore(await createDbPath());
    const first = createEvent();
    const second = createEvent({ eventId: 'event-2', outcome: 'failure', type: 'task_failure', timestamp: new Date(1_700_000_001_000).toISOString() });

    await store.addEvent(first);
    await store.addEvent(second);

    const bySubject = await store.getEvents({ subject: 'did:mesh:provider' });
    expect(bySubject).toHaveLength(2);

    const unanchored = await store.getUnanchoredEvents();
    expect(unanchored.map((event) => event.eventId)).toEqual(['event-1', 'event-2']);

    await store.markAnchored(['event-1'], 'anchor-1');
    expect((await store.getUnanchoredEvents()).map((event) => event.eventId)).toEqual(['event-2']);

    expect(await store.getStats('did:mesh:provider')).toEqual({ completed: 1, failed: 1, disputed: 0 });
    store.close();
  });

  it('preserves anchor metadata when overwriting an existing event', async () => {
    vi.useFakeTimers();
    const store = new ReputationStore(await createDbPath());
    const db = (store as unknown as { db: Database.Database }).db;

    vi.setSystemTime(1_000);
    await store.addEvent(createEvent());
    vi.setSystemTime(1_500);
    await store.markAnchored(['event-1'], 'anchor-1');

    const original = db
      .prepare('SELECT anchor_id, anchored_at, created_at FROM reputation_events WHERE event_id = ?')
      .get('event-1') as { anchor_id: string; anchored_at: number; created_at: number };

    vi.setSystemTime(2_000);
    await store.addEvent(createEvent({ outcome: 'failure', type: 'task_failure' }));

    const updated = db
      .prepare('SELECT anchor_id, anchored_at, created_at, outcome FROM reputation_events WHERE event_id = ?')
      .get('event-1') as { anchor_id: string; anchored_at: number; created_at: number; outcome: string };

    expect(updated).toEqual({ ...original, outcome: 'failure' });
    store.close();
  });
});
