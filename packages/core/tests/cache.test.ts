import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentCache, PaymentRail, type AgentCard } from '../src/index.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'agents.sqlite');
}

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xowner',
    did: 'did:mesh:agent-1' as AgentCard['did'],
    name: 'Summarizer',
    description: 'Summarizes long documents',
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarize text',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 100n,
          currency: 'MIST',
        },
      },
    ],
    endpoint: 'https://example.com',
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('AgentCache', () => {
  it('upserts and reads agents', async () => {
    const cache = new AgentCache(await createDbPath());
    const agent = createAgent();

    cache.upsertAgent(agent);

    expect(cache.getAgent(agent.id)).toEqual(agent);
    cache.close();
  });

  it('updates existing agents', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());
    cache.upsertAgent(createAgent({ name: 'Translator', version: 2, updatedAt: 2_000 }));

    const updated = cache.getAgent('0xagent-1');
    expect(updated?.name).toBe('Translator');
    expect(updated?.version).toBe(2);
    cache.close();
  });

  it('supports FTS capability searches', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());

    const matches = cache.searchByCapability('summarize');
    expect(matches.map((entry) => entry.id)).toContain('0xagent-1');
    cache.close();
  });

  it('removes agents', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());
    cache.removeAgent('0xagent-1');

    expect(cache.getAgent('0xagent-1')).toBeNull();
    cache.close();
  });

  it('finds agents by DID', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());

    expect(cache.getAgentByDID('did:mesh:agent-1')?.id).toBe('0xagent-1');
    cache.close();
  });

  it('returns only active agents', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());
    cache.upsertAgent(
      createAgent({ id: '0xagent-2', did: 'did:mesh:agent-2' as AgentCard['did'], active: false }),
    );

    expect(cache.getAllActive().map((entry) => entry.id)).toEqual(['0xagent-1']);
    cache.close();
  });
});
