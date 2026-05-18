import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { JobQueueAdapter } from '../src/provider/adapters/job-queue.js';

describe('JobQueueAdapter', () => {
  let tmpDir: string;
  let adapter: JobQueueAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'job-queue-test-'));
    adapter = new JobQueueAdapter({ dbPath: join(tmpDir, 'queue.db'), timeoutMs: 2000 });
  });

  afterEach(() => {
    adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueues work items and allows polling', async () => {
    const encoder = new TextEncoder();
    const executePromise = adapter.execute({
      taskId: 'task-1',
      capability: 'calculator',
      inputData: encoder.encode('2+2'),
    });

    const item = adapter.poll();
    expect(item).not.toBeNull();
    expect(item!.taskId).toBe('task-1');
    expect(item!.capability).toBe('calculator');
    expect(item!.inputData).toBe('2+2');
    expect(item!.status).toBe('claimed');

    const result = adapter.complete(item!.id, '4');
    expect(result.ok).toBe(true);

    const { resultData } = await executePromise;
    expect(new TextDecoder().decode(resultData)).toBe('4');
  });

  it('returns null when polling an empty queue', () => {
    expect(adapter.poll()).toBeNull();
  });

  it('lists items with status filter', async () => {
    const encoder = new TextEncoder();
    const p1 = adapter.execute({ taskId: 't1', capability: 'cap', inputData: encoder.encode('a') }).catch(() => {});
    const p2 = adapter.execute({ taskId: 't2', capability: 'cap', inputData: encoder.encode('b') }).catch(() => {});

    const all = adapter.list();
    expect(all).toHaveLength(2);
    expect(all.every((i) => i.status === 'pending')).toBe(true);

    const pending = adapter.list({ status: 'pending' });
    expect(pending).toHaveLength(2);

    adapter.poll(); // claim first item
    const claimed = adapter.list({ status: 'claimed' });
    expect(claimed).toHaveLength(1);

    // Clean up to avoid unhandled rejections
    adapter.remove(all[0].id);
    adapter.remove(all[1].id);
    await Promise.allSettled([p1, p2]);
  });

  it('fails a claimed item', async () => {
    const encoder = new TextEncoder();
    const executePromise = adapter.execute({
      taskId: 'task-fail',
      capability: 'calc',
      inputData: encoder.encode('bad input'),
    });

    const item = adapter.poll();
    const result = adapter.fail(item!.id, 'Cannot process this');
    expect(result.ok).toBe(true);

    await expect(executePromise).rejects.toThrow('Cannot process this');

    const failed = adapter.list({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('Cannot process this');
  });

  it('cannot complete an item that is not claimed', async () => {
    const encoder = new TextEncoder();
    const p = adapter.execute({ taskId: 't1', capability: 'cap', inputData: encoder.encode('x') }).catch(() => {});

    const items = adapter.list();
    const result = adapter.complete(items[0].id, 'result');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pending');

    adapter.remove(items[0].id);
    await p;
  });

  it('retry re-queues a failed item', async () => {
    const encoder = new TextEncoder();
    const p = adapter.execute({ taskId: 'retry-task', capability: 'cap', inputData: encoder.encode('x') }).catch(() => {});
    const item = adapter.poll();
    adapter.fail(item!.id, 'oops');
    await p;

    const retryResult = adapter.retry(item!.id);
    expect(retryResult.ok).toBe(true);

    const retried = adapter.getItem(item!.id);
    expect(retried!.status).toBe('pending');

    adapter.remove(item!.id);
  });

  it('remove deletes an item', async () => {
    const encoder = new TextEncoder();
    const p = adapter.execute({ taskId: 'del-task', capability: 'cap', inputData: encoder.encode('x') }).catch(() => {});
    const items = adapter.list();
    const removeResult = adapter.remove(items[0].id);
    expect(removeResult.ok).toBe(true);
    expect(adapter.list()).toHaveLength(0);
    await p;
  });

  it('times out items that are not completed', async () => {
    const fastAdapter = new JobQueueAdapter({ dbPath: join(tmpDir, 'fast-queue.db'), timeoutMs: 100 });
    const encoder = new TextEncoder();
    const executePromise = fastAdapter.execute({
      taskId: 'timeout-task',
      capability: 'cap',
      inputData: encoder.encode('slow'),
    });

    await expect(executePromise).rejects.toThrow(/timed out/);
    const items = fastAdapter.list({ status: 'failed' });
    expect(items).toHaveLength(1);
    expect(items[0].error).toContain('Timeout');
    fastAdapter.close();
  });

  it('persists data across adapter instances', async () => {
    const dbPath = join(tmpDir, 'persist.db');
    const encoder = new TextEncoder();
    const first = new JobQueueAdapter({ dbPath, timeoutMs: 60000 });
    const p = first.execute({ taskId: 'persist-task', capability: 'cap', inputData: encoder.encode('data') }).catch(() => {});
    first.close();
    await p;

    const second = new JobQueueAdapter({ dbPath, timeoutMs: 60000 });
    const items = second.list();
    expect(items).toHaveLength(1);
    expect(items[0].taskId).toBe('persist-task');
    expect(items[0].inputData).toBe('data');
    second.close();
  });
});
