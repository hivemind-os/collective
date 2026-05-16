import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PaymentRail, TaskStatus, type AgentCard, type Task } from '@hivemind-os/collective-types';

import { AnalyticsEngine } from '../src/analytics.js';
import { createIndexerGraphQLServer } from '../src/graphql/server.js';
import { IndexerStore } from '../src/store.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'graphql.sqlite');
}

function createAgent(): AgentCard {
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
    totalTasksCompleted: 4,
    totalTasksFailed: 1,
    totalTasksDisputed: 1,
    totalEarningsMist: 1_500n,
    hasStake: true,
    stakeMist: 10_000n,
    stakeType: 'agent',
  };
}

function createTask(): Task {
  return {
    id: '0xtask-1',
    requester: '0xrequester',
    provider: '0xprovider-1',
    capability: 'summarize',
    category: 'analysis',
    inputBlobId: 'blob:input',
    price: 500n,
    status: TaskStatus.RELEASED,
    disputeWindowMs: 5_000,
    createdAt: 10_000,
    completedAt: 11_000,
    expiresAt: 20_000,
  };
}

describe('Indexer GraphQL server', () => {
  it('serves agent and analytics queries', async () => {
    const store = new IndexerStore(await createDbPath());
    store.upsertAgent(createAgent());
    store.upsertTask(createTask(), '0xtx-1', 25n);

    const server = createIndexerGraphQLServer({ store, analytics: new AnalyticsEngine(store) });
    const response = await server.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query TestQuery {
          agents(capability: \"summarize\", limit: 5) {
            nodes {
              did
              reputation {
                successRate
              }
            }
          }
          analytics {
            totalTasks
          }
        }`,
      }),
    });
    const payload = await response.json() as {
      data: {
        agents: { nodes: Array<{ did: string; reputation: { successRate: number } }> };
        analytics: { totalTasks: number };
      };
    };

    expect(payload.data.agents.nodes[0]?.did).toBe('did:mesh:provider-1');
    expect(payload.data.analytics.totalTasks).toBe(1);
    store.close();
  });
});
