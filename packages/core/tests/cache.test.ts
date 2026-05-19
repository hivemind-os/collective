import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('pino', () => ({
  default: vi.fn(() => mockLogger),
}));

import { AgentCache, PaymentRail, type AgentCard } from '../src/index.js';

const createdPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.info.mockClear();
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

  it('logs and falls back to LIKE when FTS lookup fails', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());

    const db = (cache as unknown as { db: Database.Database }).db;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('agents_fts') && sql.includes('MATCH')) {
        throw new Error('fts failed');
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    const matches = cache.searchByCapability('summarize');

    expect(matches.map((entry) => entry.id)).toContain('0xagent-1');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), query: '"summarize"*' }),
      'FTS query failed, falling back to LIKE search.',
    );

    prepareSpy.mockRestore();
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

  it('supports advanced queries locally and via delegate', async () => {
    const delegated = [createAgent({ id: '0xdelegate', did: 'did:mesh:delegate' as AgentCard['did'] })];
    const delegate = vi.fn().mockResolvedValue(delegated);
    const delegatedCache = new AgentCache(await createDbPath(), { queryDelegate: delegate });
    await expect(delegatedCache.queryAgentsAdvanced({ capability: 'summarize' })).resolves.toEqual(delegated);
    delegatedCache.close();

    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent({ totalTasksCompleted: 4, totalTasksFailed: 1 }));
    const results = await cache.queryAgentsAdvanced({ capability: 'summarize', minReputation: 0.7, sortBy: 'reputation' });
    expect(results).toHaveLength(1);
    cache.close();
  });

  it('returns empty capabilities for malformed capability JSON', async () => {
    const cache = new AgentCache(await createDbPath());
    cache.upsertAgent(createAgent());

    const db = (cache as unknown as { db: Database.Database }).db;
    db.prepare('UPDATE agents SET capabilities_json = ? WHERE id = ?').run('{bad json', '0xagent-1');

    const agent = cache.getAgent('0xagent-1');

    expect(agent?.capabilities).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { value: '{bad json' },
      'Failed to parse capabilities JSON.',
    );
    cache.close();
  });
});
