import Database from 'better-sqlite3';

import type { AgentCard, Capability, ReputationScore } from '@agentic-mesh/types';

import { ReputationScoreCalculator } from '../reputation/score-calculator.js';

export interface AdvancedAgentQueryFilters {
  capability?: string;
  minReputation?: number;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'stake' | 'reputation';
}

export type AdvancedAgentQueryDelegate = (filters: AdvancedAgentQueryFilters) => Promise<AgentCard[]>;

interface AgentRow {
  rowid: number;
  id: string;
  owner: string;
  did: string;
  name: string;
  description: string | null;
  capabilities_json: string | null;
  capabilities_text: string | null;
  endpoint: string | null;
  encryption_public_key: string | null;
  active: number | bigint;
  version: number | bigint;
  registered_at: number | bigint | null;
  updated_at: number | bigint | null;
  total_tasks_completed: number | bigint | null;
  total_tasks_failed: number | bigint | null;
  total_tasks_disputed: number | bigint | null;
  total_earnings_mist: number | bigint | string | null;
  has_stake: number | bigint | null;
  stake_mist: number | bigint | string | null;
  stake_type: string | null;
}

export class AgentCache {
  private readonly db: Database.Database;
  private readonly scoreCalculator = new ReputationScoreCalculator();
  private readonly queryDelegate?: AdvancedAgentQueryDelegate;

  constructor(dbPath: string, options: { queryDelegate?: AdvancedAgentQueryDelegate } = {}) {
    this.queryDelegate = options.queryDelegate;
    this.db = new Database(dbPath);
    this.db.defaultSafeIntegers(true);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        did TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        capabilities_json TEXT,
        capabilities_text TEXT,
        endpoint TEXT,
        encryption_public_key TEXT,
        active INTEGER DEFAULT 1,
        version INTEGER DEFAULT 1,
        registered_at INTEGER,
        updated_at INTEGER,
        total_tasks_completed INTEGER,
        total_tasks_failed INTEGER,
        total_tasks_disputed INTEGER,
        total_earnings_mist TEXT,
        has_stake INTEGER,
        stake_mist TEXT,
        stake_type TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(
        agent_id UNINDEXED, name, description, capabilities_text
      );
    `);
    ensureAgentsColumn(this.db, 'encryption_public_key', 'TEXT');
    ensureAgentsColumn(this.db, 'total_tasks_completed', 'INTEGER');
    ensureAgentsColumn(this.db, 'total_tasks_failed', 'INTEGER');
    ensureAgentsColumn(this.db, 'total_tasks_disputed', 'INTEGER');
    ensureAgentsColumn(this.db, 'total_earnings_mist', 'TEXT');
    ensureAgentsColumn(this.db, 'has_stake', 'INTEGER');
    ensureAgentsColumn(this.db, 'stake_mist', 'TEXT');
    ensureAgentsColumn(this.db, 'stake_type', 'TEXT');
  }

  upsertAgent(agent: AgentCard): void {
    const capabilitiesJson = JSON.stringify(agent.capabilities, bigintReplacer);
    const capabilitiesText = agent.capabilities
      .map((entry) => `${entry.name} ${entry.description} ${entry.version}`)
      .join(' ');
    this.db
      .prepare(
        `INSERT INTO agents (
          id, owner, did, name, description, capabilities_json, capabilities_text, endpoint,
          encryption_public_key, active, version, registered_at, updated_at,
          total_tasks_completed, total_tasks_failed, total_tasks_disputed, total_earnings_mist,
          has_stake, stake_mist, stake_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          did = excluded.did,
          name = excluded.name,
          description = excluded.description,
          capabilities_json = excluded.capabilities_json,
          capabilities_text = excluded.capabilities_text,
          endpoint = excluded.endpoint,
          encryption_public_key = excluded.encryption_public_key,
          active = excluded.active,
          version = excluded.version,
          registered_at = excluded.registered_at,
          updated_at = excluded.updated_at,
          total_tasks_completed = excluded.total_tasks_completed,
          total_tasks_failed = excluded.total_tasks_failed,
          total_tasks_disputed = excluded.total_tasks_disputed,
          total_earnings_mist = excluded.total_earnings_mist,
          has_stake = excluded.has_stake,
          stake_mist = excluded.stake_mist,
          stake_type = excluded.stake_type`,
      )
      .run(
        agent.id,
        agent.owner,
        agent.did,
        agent.name,
        agent.description,
        capabilitiesJson,
        capabilitiesText,
        agent.endpoint ?? null,
        agent.encryptionPublicKey ?? null,
        agent.active ? 1 : 0,
        agent.version,
        agent.registeredAt,
        agent.updatedAt,
        agent.totalTasksCompleted ?? null,
        agent.totalTasksFailed ?? null,
        agent.totalTasksDisputed ?? null,
        agent.totalEarningsMist?.toString() ?? null,
        agent.hasStake == null ? null : agent.hasStake ? 1 : 0,
        agent.stakeMist?.toString() ?? null,
        agent.stakeType ?? null,
      );

    this.db.prepare('DELETE FROM agents_fts WHERE agent_id = ?').run(agent.id);
    this.db
      .prepare(
        'INSERT INTO agents_fts (agent_id, name, description, capabilities_text) VALUES (?, ?, ?, ?)',
      )
      .run(agent.id, agent.name, agent.description, capabilitiesText);
  }

  removeAgent(agentId: string): void {
    this.db.prepare('DELETE FROM agents_fts WHERE agent_id = ?').run(agentId);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  }

  getAgent(agentId: string): AgentCard | null {
    const row = this.db.prepare('SELECT rowid, * FROM agents WHERE id = ?').get(agentId) as
      | AgentRow
      | undefined;
    return row ? mapAgentRow(row) : null;
  }

  getAgentByDID(did: string): AgentCard | null {
    const row = this.db.prepare('SELECT rowid, * FROM agents WHERE did = ?').get(did) as
      | AgentRow
      | undefined;
    return row ? mapAgentRow(row) : null;
  }

  searchByCapability(
    query: string,
    limit = 20,
    options: { sortByReputation?: boolean; scores?: Map<string, ReputationScore> } = {},
  ): AgentCard[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    try {
      const rows = this.db
        .prepare(
          `SELECT a.rowid, a.*
           FROM agents_fts
           JOIN agents a ON a.id = agents_fts.agent_id
           WHERE agents_fts MATCH ? AND a.active = 1
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as AgentRow[];
      return rankAgents(rows.map(mapAgentRow), options, this.scoreCalculator).slice(0, limit);
    } catch {
      const like = `%${query}%`;
      const rows = this.db
        .prepare(
          `SELECT rowid, * FROM agents
           WHERE active = 1
             AND (name LIKE ? OR description LIKE ? OR capabilities_json LIKE ? OR capabilities_text LIKE ?)
           LIMIT ?`,
        )
        .all(like, like, like, like, limit) as AgentRow[];
      return rankAgents(rows.map(mapAgentRow), options, this.scoreCalculator).slice(0, limit);
    }
  }

  getAllActive(limit = 100): AgentCard[] {
    const rows = this.db
      .prepare('SELECT rowid, * FROM agents WHERE active = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as AgentRow[];
    return rows.map(mapAgentRow);
  }

  async queryAgentsAdvanced(filters: AdvancedAgentQueryFilters = {}): Promise<AgentCard[]> {
    if (this.queryDelegate) {
      try {
        return await this.queryDelegate(filters);
      } catch {
        // Fall through to the local cache query.
      }
    }

    const limit = normalizeLimit(filters.limit, 20);
    const offset = normalizeOffset(filters.offset);
    const search = filters.search?.trim();
    const capability = filters.capability?.trim();

    let agents = search || capability
      ? this.searchByCapability(search ?? capability ?? '', Math.max(limit + offset, limit), {
          sortByReputation: filters.sortBy === 'reputation',
        })
      : this.getAllActive(Math.max(limit + offset, 100));

    if (capability) {
      agents = agents.filter((agent) => agent.capabilities.some((entry) => equalsIgnoreCase(entry.name, capability)));
    }
    if (search) {
      const searchLower = search.toLowerCase();
      agents = agents.filter((agent) => matchesSearch(agent, searchLower));
    }
    if (filters.category) {
      const categoryLower = filters.category.toLowerCase();
      agents = agents.filter((agent) =>
        agent.capabilities.some(
          (entry) =>
            entry.name.toLowerCase().includes(categoryLower) ||
            entry.description.toLowerCase().includes(categoryLower),
        ) || agent.description.toLowerCase().includes(categoryLower),
      );
    }

    const scores = new Map(agents.map((agent) => [agent.did, this.scoreCalculator.computeScore(agent, [])]));
    const minReputation = typeof filters.minReputation === 'number' ? filters.minReputation : undefined;
    if (minReputation !== undefined) {
      agents = agents.filter((agent) => (scores.get(agent.did)?.successRate ?? 0) >= minReputation);
    }

    const ranked = rankAgents(
      agents,
      { sortByReputation: filters.sortBy === 'reputation', scores },
      this.scoreCalculator,
    );
    return ranked.slice(offset, offset + limit);
  }

  close(): void {
    this.db.close();
  }
}

function mapAgentRow(row: AgentRow): AgentCard {
  return {
    id: row.id,
    owner: row.owner,
    did: row.did as AgentCard['did'],
    name: row.name,
    description: row.description ?? '',
    capabilities: parseCapabilities(row.capabilities_json),
    endpoint: row.endpoint ?? undefined,
    encryptionPublicKey: row.encryption_public_key ?? undefined,
    active: Number(row.active) === 1,
    version: Number(row.version),
    registeredAt: Number(row.registered_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    totalTasksCompleted: row.total_tasks_completed == null ? undefined : Number(row.total_tasks_completed),
    totalTasksFailed: row.total_tasks_failed == null ? undefined : Number(row.total_tasks_failed),
    totalTasksDisputed: row.total_tasks_disputed == null ? undefined : Number(row.total_tasks_disputed),
    totalEarningsMist: row.total_earnings_mist == null ? undefined : BigInt(row.total_earnings_mist),
    hasStake: row.has_stake == null ? undefined : Number(row.has_stake) === 1,
    stakeMist: row.stake_mist == null ? undefined : BigInt(row.stake_mist),
    stakeType: row.stake_type === 'agent' || row.stake_type === 'relay' ? row.stake_type : undefined,
  };
}

function parseCapabilities(value: string | null): Capability[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as Array<Capability & { pricing: Capability['pricing'] & { amount: string } }>;
  return parsed.map((entry) => ({
    ...entry,
    pricing: {
      ...entry.pricing,
      amount: BigInt(entry.pricing.amount),
    },
  }));
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function ensureAgentsColumn(db: Database.Database, column: string, type: string): void {
  const columns = db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE agents ADD COLUMN ${column} ${type}`);
  }
}

function matchesSearch(agent: AgentCard, searchLower: string): boolean {
  return (
    agent.name.toLowerCase().includes(searchLower) ||
    agent.description.toLowerCase().includes(searchLower) ||
    agent.capabilities.some(
      (entry) =>
        entry.name.toLowerCase().includes(searchLower) ||
        entry.description.toLowerCase().includes(searchLower) ||
        entry.version.toLowerCase().includes(searchLower),
    )
  );
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return fallback;
  }
  return Math.max(1, Math.floor(limit));
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || Number.isNaN(offset)) {
    return 0;
  }
  return Math.max(0, Math.floor(offset));
}

function buildFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);

  return terms.map((term) => `"${term}"*`).join(' OR ');
}

function rankAgents(
  agents: AgentCard[],
  options: { sortByReputation?: boolean; scores?: Map<string, ReputationScore> },
  calculator: ReputationScoreCalculator,
): AgentCard[] {
  if (!options.sortByReputation) {
    return [...agents].sort(compareStakePreference);
  }

  const scores = options.scores ?? new Map(agents.map((agent) => [agent.did, calculator.computeScore(agent, [])]));
  return calculator.rankByReputation(agents, scores);
}

function compareStakePreference(left: AgentCard, right: AgentCard): number {
  return (
    compareBoolean(left.hasStake ?? false, right.hasStake ?? false) ||
    compareBigInt(left.stakeMist ?? 0n, right.stakeMist ?? 0n) ||
    compareNumber(left.updatedAt, right.updatedAt)
  );
}

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) {
    return 0;
  }
  return left ? -1 : 1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}