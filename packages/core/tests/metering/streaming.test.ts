import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamingPaymentManager } from '../../src/metering/streaming.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'streaming.sqlite');
}

describe('StreamingPaymentManager', () => {
  it('tracks a stream lifecycle and audit trail', async () => {
    const paymentProcessor = vi.fn();
    const manager = new StreamingPaymentManager({ dbPath: await createDbPath(), now: () => 1_700_000_000_000, paymentProcessor });

    expect(manager.startStream('task-1', 1_000n, 400n)).toEqual({
      taskId: 'task-1',
      totalPaid: 0n,
      maxBudget: 1_000n,
      currentUnit: 0,
      lastPaymentTimestamp: 1_700_000_000_000,
    });
    await expect(manager.payUnit('task-1')).resolves.toMatchObject({ totalPaid: 400n, currentUnit: 1 });
    await expect(manager.payUnit('task-1')).resolves.toMatchObject({ totalPaid: 800n, currentUnit: 2 });
    await expect(manager.payUnit('task-1')).resolves.toMatchObject({ totalPaid: 1_000n, currentUnit: 3 });

    expect(paymentProcessor).toHaveBeenCalledTimes(3);
    expect(manager.getAuditTrail('task-1')).toHaveLength(3);
    expect(manager.finalizeStream('task-1')).toEqual({
      state: {
        taskId: 'task-1',
        totalPaid: 1_000n,
        maxBudget: 1_000n,
        currentUnit: 3,
        lastPaymentTimestamp: 1_700_000_000_000,
      },
      refundAmount: 0n,
    });
    manager.close();
  });
});
