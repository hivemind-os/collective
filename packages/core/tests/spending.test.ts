import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaymentRail, SpendingPolicyEngine } from '../src/index.js';

const createdPaths: string[] = [];
const basePolicy = { limits: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-02T12:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'spending.sqlite');
}

describe('SpendingPolicyEngine', () => {
  it('approves everything for an empty policy', async () => {
    const engine = new SpendingPolicyEngine({ policy: basePolicy, dbPath: await createDbPath() });

    expect(engine.evaluate({ amountMist: 1_000n, rail: PaymentRail.SUI_ESCROW })).toEqual({
      approved: true,
    });

    engine.close();
  });

  it('enforces a daily limit', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath(),
    });

    expect(engine.evaluate({ amountMist: 60n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);
    engine.record({ amountMist: 60n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-1' });
    expect(engine.evaluate({ amountMist: 50n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);

    engine.close();
  });

  it('enforces transaction and daily limits together', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [
          { amount: 80n, interval: 'transaction', rail: PaymentRail.SUI_ESCROW },
          { amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW },
        ],
      },
      dbPath: await createDbPath(),
    });

    expect(engine.evaluate({ amountMist: 90n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);
    engine.record({ amountMist: 40n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-2' });
    expect(engine.evaluate({ amountMist: 70n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);
    expect(engine.evaluate({ amountMist: 50n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);

    engine.close();
  });

  it('records spending and reports totals', async () => {
    const engine = new SpendingPolicyEngine({ policy: basePolicy, dbPath: await createDbPath() });
    engine.record({ amountMist: 25n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-3' });
    engine.record({ amountMist: 15n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-4' });

    expect(engine.getSpent('day')).toBe(40n);

    engine.close();
  });

  it('updates policy rules at runtime', async () => {
    const engine = new SpendingPolicyEngine({ policy: basePolicy, dbPath: await createDbPath() });
    expect(engine.evaluate({ amountMist: 200n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);

    engine.updatePolicy({
      limits: [{ amount: 100n, interval: 'transaction', rail: PaymentRail.SUI_ESCROW }],
    });

    expect(engine.evaluate({ amountMist: 200n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);
    engine.close();
  });

  it("doesn't count yesterday's spending against today's limit", async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath(),
    });

    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    engine.record({ amountMist: 90n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-yesterday' });

    vi.setSystemTime(new Date('2025-01-02T12:00:00.000Z'));
    expect(engine.evaluate({ amountMist: 50n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);

    engine.close();
  });
});
