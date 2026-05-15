import Database from 'better-sqlite3';

import type { AgentCard, Capability } from '@agentic-mesh/types';

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
  active: number | bigint;
  version: number | bigint;
  registered_at: number | bigint | null;
  updated_at: number | bigint | null;
}

export class AgentCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
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
        active INTEGER DEFAULT 1,
        version INTEGER DEFAULT 1,
        registered_at INTEGER,
        updated_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(
        agent_id UNINDEXED, name, description, capabilities_text
      );
    `);
  }

  upsertAgent(agent: AgentCard): void {
    const capabilitiesJson = JSON.stringify(agent.capabilities, bigintReplacer);
    const capabilitiesText = agent.capabilities
      .map((entry) => `${entry.name} ${entry.description} ${entry.version}`)
      .join(' ');
    this.db
      .prepare(
        `INSERT INTO agents (
          id, owner, did, name, description, capabilities_json, capabilities_text, endpoint, active, version, registered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          did = excluded.did,
          name = excluded.name,
          description = excluded.description,
          capabilities_json = excluded.capabilities_json,
          capabilities_text = excluded.capabilities_text,
          endpoint = excluded.endpoint,
          active = excluded.active,
          version = excluded.version,
          registered_at = excluded.registered_at,
          updated_at = excluded.updated_at`,
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
        agent.active ? 1 : 0,
        agent.version,
        agent.registeredAt,
        agent.updatedAt,
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

  searchByCapability(query: string, limit = 20): AgentCard[] {
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
      return rows.map(mapAgentRow);
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
      return rows.map(mapAgentRow);
    }
  }

  getAllActive(limit = 100): AgentCard[] {
    const rows = this.db
      .prepare('SELECT rowid, * FROM agents WHERE active = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as AgentRow[];
    return rows.map(mapAgentRow);
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
    active: Number(row.active) === 1,
    version: Number(row.version),
    registeredAt: Number(row.registered_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
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

function buildFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);

  return terms.map((term) => `"${term}"*`).join(' OR ');
}
