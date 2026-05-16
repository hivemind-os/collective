import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PaymentRail, SpendingPolicyEngine } from '@hivemind-os/collective-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createdPaths: string[] = [];
const openEngines = new Set<SpendingPolicyEngine>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-02-01T10:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const engine of openEngines) {
    engine.close();
  }
  openEngines.clear();
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(name: string): Promise<string> {
  const dir = resolve(process.cwd(), '.artifacts', `spending-policy-${name}-${randomUUID()}`);
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'spending.sqlite');
}

describe('Phase 1 E2E: Spending policy engine', () => {
  it('rejects a single transaction above the configured per-transaction limit', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'transaction', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath('per-transaction'),
    });
    openEngines.add(engine);

    expect(engine.evaluate({ amountMist: 100n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 101n, rail: PaymentRail.SUI_ESCROW })).toEqual({
      approved: false,
      reason: 'Transaction limit exceeded for transaction.',
    });

    engine.close();
  });

  it('accumulates daily spending and rejects requests beyond the daily limit', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 150n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath('daily-limit'),
    });
    openEngines.add(engine);

    engine.record({ amountMist: 60n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-1', originAppName: 'alpha' });
    engine.record({ amountMist: 70n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-2', originAppName: 'beta' });

    expect(engine.getSpent('day', PaymentRail.SUI_ESCROW)).toBe(130n);
    expect(engine.evaluate({ amountMist: 20n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 21n, rail: PaymentRail.SUI_ESCROW })).toEqual({
      approved: false,
      reason: 'Spending limit exceeded for day.',
    });

    engine.close();
  });

  it('accumulates monthly spending and rejects requests beyond the monthly limit', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 500n, interval: 'month', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath('monthly-limit'),
    });
    openEngines.add(engine);

    engine.record({ amountMist: 200n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-a', originAppName: 'alpha' });
    vi.setSystemTime(new Date('2025-02-15T12:00:00.000Z'));
    engine.record({ amountMist: 250n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-b', originAppName: 'beta' });

    expect(engine.getSpent('month', PaymentRail.SUI_ESCROW)).toBe(450n);
    expect(engine.evaluate({ amountMist: 50n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 51n, rail: PaymentRail.SUI_ESCROW })).toEqual({
      approved: false,
      reason: 'Spending limit exceeded for month.',
    });

    engine.close();
  });

  it('applies different per-app limits independently', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 1_000n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
        perApp: {
          claude: {
            limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
          },
          vscode: {
            limits: [{ amount: 200n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
          },
        },
      },
      dbPath: await createDbPath('per-app'),
    });
    openEngines.add(engine);

    engine.record({ amountMist: 80n, rail: PaymentRail.SUI_ESCROW, taskId: 'claude-1', originAppName: 'claude' });
    engine.record({ amountMist: 150n, rail: PaymentRail.SUI_ESCROW, taskId: 'vscode-1', originAppName: 'vscode' });

    expect(engine.evaluate({ amountMist: 20n, rail: PaymentRail.SUI_ESCROW, originAppName: 'claude' }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 21n, rail: PaymentRail.SUI_ESCROW, originAppName: 'claude' }).approved).toBe(false);
    expect(engine.evaluate({ amountMist: 50n, rail: PaymentRail.SUI_ESCROW, originAppName: 'vscode' }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 51n, rail: PaymentRail.SUI_ESCROW, originAppName: 'vscode' }).approved).toBe(false);

    engine.close();
  });

  it('enforces the global limit across all apps combined', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 300n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath('global-limit'),
    });
    openEngines.add(engine);

    engine.record({ amountMist: 120n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-1', originAppName: 'claude' });
    engine.record({ amountMist: 140n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-2', originAppName: 'vscode' });

    expect(engine.evaluate({ amountMist: 40n, rail: PaymentRail.SUI_ESCROW, originAppName: 'cursor' }).approved).toBe(true);
    expect(engine.evaluate({ amountMist: 41n, rail: PaymentRail.SUI_ESCROW, originAppName: 'cursor' }).approved).toBe(false);

    engine.close();
  });

  it('persists the spending log across engine restarts', async () => {
    const dbPath = await createDbPath('restart-persistence');
    const firstEngine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 500n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath,
    });

    firstEngine.record({ amountMist: 125n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-1', originAppName: 'claude' });
    firstEngine.record({ amountMist: 75n, rail: PaymentRail.SUI_ESCROW, taskId: 'task-2', originAppName: 'claude' });
    firstEngine.close();

    const secondEngine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 500n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath,
    });
    openEngines.add(secondEngine);

    expect(secondEngine.getSpent('day', PaymentRail.SUI_ESCROW)).toBe(200n);
    expect(secondEngine.evaluate({ amountMist: 300n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);
    expect(secondEngine.evaluate({ amountMist: 301n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);

    secondEngine.close();
  });

  it('resets the daily counter at the midnight boundary', async () => {
    const engine = new SpendingPolicyEngine({
      policy: {
        limits: [{ amount: 100n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      },
      dbPath: await createDbPath('midnight-reset'),
    });
    openEngines.add(engine);

    vi.setSystemTime(new Date('2025-02-01T23:59:59.000'));
    engine.record({ amountMist: 90n, rail: PaymentRail.SUI_ESCROW, taskId: 'late-task', originAppName: 'claude' });
    expect(engine.evaluate({ amountMist: 11n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(false);

    vi.setSystemTime(new Date('2025-02-02T00:00:01.000'));
    expect(engine.getSpent('day', PaymentRail.SUI_ESCROW)).toBe(0n);
    expect(engine.evaluate({ amountMist: 100n, rail: PaymentRail.SUI_ESCROW }).approved).toBe(true);

    engine.close();
  });
});
