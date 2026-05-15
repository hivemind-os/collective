import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PaymentRail, TaskStatus, type AgentCard, type Task } from '@agentic-mesh/types';

import { AnalyticsEngine } from '../src/analytics.js';
import { IndexerStore } from '../src/store.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'analytics.sqlite');
}

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xprovider-1',
    did: 'did:mesh:provider-1' as AgentCard['did'],
    name: 'Provider One',
    description: 'Provider',
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarize',
        version: '1.0.0',
        pricing: { rail: PaymentRail.SUI_ESCROW, amount: 100n, currency: 'MIST' },
      },
    ],
    active: true,
    version: 1,
    registeredAt: 1,
    updatedAt: 2,
    totalTasksCompleted: 5,
    totalTasksFailed: 1,
    totalTasksDisputed: 1,
    totalEarningsMist: 2_000n,
    ...overrides,
  };
}

function createTask(id: string, createdAt: number, status: TaskStatus, price = 500n): Task {
  return {
    id,
    requester: '0xrequester',
    provider: '0xprovider-1',
    capability: 'summarize',
    category: createdAt % 2 === 0 ? 'analysis' : 'research',
    inputBlobId: `blob:${id}`,
    price,
    status,
    disputeWindowMs: 5_000,
    createdAt,
    completedAt: status >= TaskStatus.COMPLETED ? createdAt + 100 : undefined,
    expiresAt: createdAt + 1_000,
  };
}

describe('AnalyticsEngine', () => {
  it('computes summaries, task volume, and top providers', async () => {
    const store = new IndexerStore(await createDbPath());
    store.upsertAgent(createAgent());
    store.upsertTask(createTask('0xtask-1', 1_000, TaskStatus.RELEASED), '0xtx-1', 10n);
    store.upsertTask(createTask('0xtask-2', 2_000, TaskStatus.COMPLETED), '0xtx-2', 30n);
    store.upsertTask(createTask('0xtask-3', 3_000, TaskStatus.DISPUTED), '0xtx-3', 50n);

    const analytics = new AnalyticsEngine(store);
    const summary = analytics.getSummary();
    const taskVolume = analytics.getTaskVolume('day', 5);
    const providers = analytics.getTopProviders(5, 'reputation');

    expect(summary.totalAgents).toBe(1);
    expect(summary.totalTasks).toBe(3);
    expect(summary.averageGasCosts[0]?.averageGasMist).toBe(30n);
    expect(taskVolume).toHaveLength(1);
    expect(providers[0]?.did).toBe('did:mesh:provider-1');
    store.close();
  });
});
