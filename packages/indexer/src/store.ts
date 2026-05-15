import Database from 'better-sqlite3';

import { ReputationScoreCalculator } from '@agentic-mesh/core';
import type { AgentCard, Bid, Capability, Dispute, Task } from '@agentic-mesh/types';
import { BidStatus, DisputeStatus, PaymentScheme, TaskStatus } from '@agentic-mesh/types';

export interface AgentQueryFilters {
  capability?: string;
  minReputation?: number;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'stake' | 'reputation';
  activeOnly?: boolean;
}

export interface TaskQueryFilters {
  status?: TaskStatus;
  requester?: string;
  provider?: string;
  category?: string;
  after?: string;
  limit?: number;
}

export interface DisputeQueryFilters {
  status?: DisputeStatus;
  agent?: string;
}

export interface StoredEvent {
  eventId: string;
  eventType: string;
  packageId: string;
  txDigest: string;
  timestampMs: number;
  payload: unknown;
  checkpoint?: number;
  module?: string;
}

export interface IndexedTaskTransition {
  taskId: string;
  eventType: string;
  status: TaskStatus;
  txDigest: string;
  timestampMs: number;
  payload: Record<string, unknown>;
}

export interface IndexedTask extends Task {
  releasedAt?: number;
  disputedAt?: number;
  cancelledAt?: number;
  bidCount: number;
  gasCostMistTotal: bigint;
  transitions?: IndexedTaskTransition[];
}

export interface ProviderStatsRecord {
  did: string;
  owner: string;
  name: string;
  completedTasks: number;
  earningsMist: bigint;
  disputeCount: number;
  successRate: number;
  reputation: number;
}

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
  total_earnings_mist: string | null;
  has_stake: number | bigint | null;
  stake_mist: string | null;
  stake_type: string | null;
}

interface TaskRow {
  id: string;
  requester: string;
  provider: string | null;
  capability: string;
  category: string;
  input_blob_id: string;
  result_blob_id: string | null;
  price: string;
  payment_scheme: string | null;
  max_price: string | null;
  metered_units: number | bigint | null;
  unit_price: string | null;
  verification_hash: string | null;
  status: number | bigint;
  dispute_window_ms: number | bigint | null;
  created_at: number | bigint;
  accepted_at: number | bigint | null;
  completed_at: number | bigint | null;
  released_at: number | bigint | null;
  disputed_at: number | bigint | null;
  cancelled_at: number | bigint | null;
  expires_at: number | bigint;
  agreement_hash: string | null;
  posted_tx_digest: string | null;
  accepted_tx_digest: string | null;
  completed_tx_digest: string | null;
  released_tx_digest: string | null;
  disputed_tx_digest: string | null;
  cancelled_tx_digest: string | null;
  gas_cost_mist_total: string | null;
  bid_count: number | bigint | null;
}

interface BidRow {
  id: string;
  task_id: string;
  bidder: string;
  bid_price: string;
  reputation_score: string;
  evidence_blob: string | null;
  created_at: number | bigint;
  accepted_at: number | bigint | null;
  rejected_at: number | bigint | null;
  withdrawn_at: number | bigint | null;
  status: number | bigint;
}

interface DisputeRow {
  id: string;
  task_id: string;
  requester: string;
  provider: string;
  escrow_amount: string;
  status: number | bigint;
  requester_evidence_blob: string;
  provider_evidence_blob: string | null;
  requester_proposed_split: string;
  provider_proposed_split: string;
  arbitrator: string | null;
  ruling_split: string;
  opened_at: number | bigint;
  responded_at: number | bigint | null;
  resolved_at: number | bigint | null;
  resolution_deadline: number | bigint;
}

interface TransitionRow {
  task_id: string;
  event_type: string;
  status: number | bigint;
  tx_digest: string;
  timestamp_ms: number | bigint;
  payload_json: string;
}

export class IndexerStore {
  readonly db: Database.Database;

  private readonly scoreCalculator = new ReputationScoreCalculator();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.defaultSafeIntegers(true);
    this.db.function('add_bigint', { deterministic: true }, (left: string | number | bigint | null, right: string | number | bigint | null) => {
      return (toBigInt(left) + toBigInt(right)).toString();
    });
    this.db.function('subtract_bigint', { deterministic: true }, (left: string | number | bigint | null, right: string | number | bigint | null) => {
      const value = toBigInt(left) - toBigInt(right);
      return value < 0n ? '0' : value.toString();
    });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_cursors (
        stream_key TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        package_id TEXT NOT NULL,
        tx_digest TEXT NOT NULL,
        module_name TEXT,
        checkpoint INTEGER,
        timestamp_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_type_timestamp_idx ON events (event_type, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS events_tx_digest_idx ON events (tx_digest);

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
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
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
      CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner);
      CREATE INDEX IF NOT EXISTS agents_did_idx ON agents (did);
      CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(agent_id UNINDEXED, name, description, capabilities_text);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        provider TEXT,
        capability TEXT NOT NULL,
        category TEXT NOT NULL,
        input_blob_id TEXT NOT NULL,
        result_blob_id TEXT,
        price TEXT NOT NULL,
        payment_scheme TEXT,
        max_price TEXT,
        metered_units INTEGER,
        unit_price TEXT,
        verification_hash TEXT,
        status INTEGER NOT NULL,
        dispute_window_ms INTEGER,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        completed_at INTEGER,
        released_at INTEGER,
        disputed_at INTEGER,
        cancelled_at INTEGER,
        expires_at INTEGER NOT NULL,
        agreement_hash TEXT,
        posted_tx_digest TEXT,
        accepted_tx_digest TEXT,
        completed_tx_digest TEXT,
        released_tx_digest TEXT,
        disputed_tx_digest TEXT,
        cancelled_tx_digest TEXT,
        gas_cost_mist_total TEXT DEFAULT '0',
        bid_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_provider_created_idx ON tasks (provider, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_requester_created_idx ON tasks (requester, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_category_created_idx ON tasks (category, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_capability_created_idx ON tasks (capability, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_created_cursor_idx ON tasks (created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS task_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status INTEGER NOT NULL,
        tx_digest TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_transitions_task_idx ON task_transitions (task_id, timestamp_ms ASC, id ASC);

      CREATE TABLE IF NOT EXISTS bids (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        bidder TEXT NOT NULL,
        bid_price TEXT NOT NULL,
        reputation_score TEXT NOT NULL,
        evidence_blob TEXT,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        rejected_at INTEGER,
        withdrawn_at INTEGER,
        status INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bids_task_idx ON bids (task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS bids_status_idx ON bids (status);

      CREATE TABLE IF NOT EXISTS disputes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        requester TEXT NOT NULL,
        provider TEXT NOT NULL,
        escrow_amount TEXT NOT NULL,
        status INTEGER NOT NULL,
        requester_evidence_blob TEXT NOT NULL,
        provider_evidence_blob TEXT,
        requester_proposed_split TEXT NOT NULL,
        provider_proposed_split TEXT NOT NULL,
        arbitrator TEXT,
        ruling_split TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        responded_at INTEGER,
        resolved_at INTEGER,
        resolution_deadline INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS disputes_task_idx ON disputes (task_id);
      CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes (status);

      CREATE TABLE IF NOT EXISTS stakes (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        amount_mist TEXT NOT NULL DEFAULT '0',
        active INTEGER NOT NULL DEFAULT 1,
        stake_type TEXT,
        staked_at INTEGER,
        deactivated_at INTEGER,
        withdrawn_at INTEGER,
        slashed_amount_mist TEXT NOT NULL DEFAULT '0',
        last_updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stakes_owner_idx ON stakes (owner);

      CREATE TABLE IF NOT EXISTS reputation_anchors (
        anchor_id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        merkle_root TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        blob_id TEXT,
        from_timestamp INTEGER,
        to_timestamp INTEGER,
        created_at INTEGER NOT NULL,
        tx_digest TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reputation_anchors_author_idx ON reputation_anchors (author, created_at DESC);
    `);
    ensureTaskColumns(this.db);
  }

  close(): void {
    this.db.close();
  }

  getCursor(streamKey: string): { txDigest: string; eventSeq: string } | null {
    const row = this.db.prepare('SELECT cursor_json FROM indexer_cursors WHERE stream_key = ?').get(streamKey) as
      | { cursor_json: string }
      | undefined;
    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.cursor_json) as { txDigest: string; eventSeq: string };
    } catch {
      return null;
    }
  }

  setCursor(streamKey: string, cursor: { txDigest: string; eventSeq: string }): void {
    this.db
      .prepare(
        `INSERT INTO indexer_cursors (stream_key, cursor_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(stream_key)
         DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
      )
      .run(streamKey, JSON.stringify(cursor), Date.now());
  }

  recordEvent(event: StoredEvent): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (
          event_id, event_type, package_id, tx_digest, module_name, checkpoint, timestamp_ms, payload_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.eventType,
        event.packageId,
        event.txDigest,
        event.module ?? null,
        event.checkpoint ?? null,
        event.timestampMs,
        JSON.stringify(event.payload, bigintReplacer),
        Date.now(),
      );
    return result.changes > 0;
  }

  upsertAgent(agent: AgentCard): void {
    const capabilitiesJson = JSON.stringify(agent.capabilities, bigintReplacer);
    const capabilitiesText = buildCapabilitiesText(agent.capabilities);
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
          total_tasks_completed = COALESCE(excluded.total_tasks_completed, agents.total_tasks_completed),
          total_tasks_failed = COALESCE(excluded.total_tasks_failed, agents.total_tasks_failed),
          total_tasks_disputed = COALESCE(excluded.total_tasks_disputed, agents.total_tasks_disputed),
          total_earnings_mist = COALESCE(excluded.total_earnings_mist, agents.total_earnings_mist),
          has_stake = COALESCE(excluded.has_stake, agents.has_stake),
          stake_mist = COALESCE(excluded.stake_mist, agents.stake_mist),
          stake_type = COALESCE(excluded.stake_type, agents.stake_type)`,
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
      .prepare('INSERT INTO agents_fts (agent_id, name, description, capabilities_text) VALUES (?, ?, ?, ?)')
      .run(agent.id, agent.name, agent.description, capabilitiesText);
  }

  markAgentInactive(agentId: string): void {
    this.db.prepare('UPDATE agents SET active = 0 WHERE id = ?').run(agentId);
  }

  getAgentByDid(did: string): AgentCard | null {
    const row = this.db.prepare('SELECT rowid, * FROM agents WHERE did = ?').get(did) as AgentRow | undefined;
    return row ? mapAgentRow(row) : null;
  }

  queryAgents(filters: AgentQueryFilters = {}): AgentCard[] {
    const limit = normalizeLimit(filters.limit, 20);
    const offset = normalizeOffset(filters.offset);
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (filters.activeOnly !== false) {
      clauses.push('a.active = 1');
    }
    if (filters.category) {
      clauses.push('EXISTS (SELECT 1 FROM tasks t WHERE t.provider = a.owner AND t.category = ?)');
      values.push(filters.category);
    }

    const search = filters.search?.trim();
    const capability = filters.capability?.trim();
    const searchQuery = search ?? capability;
    let rows: AgentRow[] = [];

    if (searchQuery) {
      const ftsQuery = buildFtsQuery(searchQuery);
      const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
      try {
        rows = this.db
          .prepare(
            `SELECT a.rowid, a.*
             FROM agents_fts
             JOIN agents a ON a.id = agents_fts.agent_id
             WHERE agents_fts MATCH ? ${where}
             LIMIT ? OFFSET ?`,
          )
          .all(ftsQuery, ...values, Math.max(limit * 4, 50), offset) as AgentRow[];
      } catch {
        const like = `%${searchQuery}%`;
        const whereClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
        rows = this.db
          .prepare(
            `SELECT rowid, * FROM agents a
             WHERE (a.name LIKE ? OR a.description LIKE ? OR a.capabilities_text LIKE ? OR a.capabilities_json LIKE ?)
             ${whereClause}
             LIMIT ? OFFSET ?`,
          )
          .all(like, like, like, like, ...values, Math.max(limit * 4, 50), offset) as AgentRow[];
      }
    } else {
      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      rows = this.db
        .prepare(`SELECT rowid, * FROM agents a ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(Math.max(limit * 4, 50), offset) as AgentRow[];
    }

    let agents = rows.map(mapAgentRow);
    if (capability) {
      agents = agents.filter((agent) => agent.capabilities.some((entry) => equalsIgnoreCase(entry.name, capability)));
    }
    if (search) {
      const searchLower = search.toLowerCase();
      agents = agents.filter((agent) => matchesSearch(agent, searchLower));
    }

    const scores = new Map(agents.map((agent) => [agent.did, this.scoreCalculator.computeScore(agent, [])]));
    const minReputation = typeof filters.minReputation === 'number' ? filters.minReputation : undefined;
    if (minReputation !== undefined) {
      agents = agents.filter((agent) => (scores.get(agent.did)?.successRate ?? 0) >= minReputation);
    }

    const ranked = filters.sortBy === 'reputation'
      ? this.scoreCalculator.rankByReputation(agents, scores)
      : [...agents].sort(compareStakePreference);
    return ranked.slice(0, limit);
  }

  countAgents(filters: AgentQueryFilters = {}): number {
    return this.queryAgents({ ...filters, limit: 10_000, offset: 0 }).length;
  }

  upsertTask(task: Task, txDigest: string, gasCostMist = 0n): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, requester, provider, capability, category, input_blob_id, result_blob_id, price,
          payment_scheme, max_price, metered_units, unit_price, verification_hash,
          status, dispute_window_ms, created_at, accepted_at, completed_at, released_at, disputed_at, cancelled_at,
          expires_at, agreement_hash, posted_tx_digest, gas_cost_mist_total, bid_count
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT bid_count FROM tasks WHERE id = ?), 0)
        )
        ON CONFLICT(id) DO UPDATE SET
          requester = excluded.requester,
          provider = COALESCE(excluded.provider, tasks.provider),
          capability = excluded.capability,
          category = excluded.category,
          input_blob_id = excluded.input_blob_id,
          result_blob_id = COALESCE(excluded.result_blob_id, tasks.result_blob_id),
          price = excluded.price,
          payment_scheme = COALESCE(excluded.payment_scheme, tasks.payment_scheme),
          max_price = COALESCE(excluded.max_price, tasks.max_price),
          metered_units = COALESCE(excluded.metered_units, tasks.metered_units),
          unit_price = COALESCE(excluded.unit_price, tasks.unit_price),
          verification_hash = COALESCE(excluded.verification_hash, tasks.verification_hash),
          status = excluded.status,
          dispute_window_ms = excluded.dispute_window_ms,
          created_at = excluded.created_at,
          accepted_at = COALESCE(excluded.accepted_at, tasks.accepted_at),
          completed_at = COALESCE(excluded.completed_at, tasks.completed_at),
          expires_at = excluded.expires_at,
          agreement_hash = COALESCE(excluded.agreement_hash, tasks.agreement_hash),
          posted_tx_digest = COALESCE(excluded.posted_tx_digest, tasks.posted_tx_digest),
          gas_cost_mist_total = add_bigint(tasks.gas_cost_mist_total, excluded.gas_cost_mist_total)`,
      )
      .run(
        task.id,
        task.requester,
        task.provider ?? null,
        task.capability,
        task.category,
        task.inputBlobId,
        task.resultBlobId ?? null,
        task.price.toString(),
        task.paymentScheme ?? null,
        task.maxPrice?.toString() ?? null,
        task.meteredUnits ?? null,
        task.unitPrice?.toString() ?? null,
        task.verificationHash ?? null,
        task.status,
        task.disputeWindowMs,
        task.createdAt,
        task.acceptedAt ?? null,
        task.completedAt ?? null,
        null,
        null,
        null,
        task.expiresAt,
        task.agreementHash ?? null,
        txDigest,
        gasCostMist.toString(),
        task.id,
      );
    this.recordTaskTransition(task.id, 'task.posted', TaskStatus.OPEN, txDigest, task.createdAt, task as unknown as Record<string, unknown>);
  }

  updateTaskStatus(params: {
    taskId: string;
    status: TaskStatus;
    txDigest: string;
    timestampMs: number;
    provider?: string;
    requester?: string;
    resultBlobId?: string;
    price?: bigint;
    paymentScheme?: Task['paymentScheme'];
    meteredUnits?: number;
    maxPrice?: bigint;
    unitPrice?: bigint;
    verificationHash?: string;
    gasCostMist?: bigint;
    eventType: string;
    payload: Record<string, unknown>;
  }): void {
    const gasCost = params.gasCostMist?.toString() ?? '0';
    const columnUpdates: string[] = ['status = ?', 'provider = COALESCE(?, provider)', 'gas_cost_mist_total = add_bigint(gas_cost_mist_total, ?)'];
    const values: Array<number | string | null> = [params.status, params.provider ?? null, gasCost];

    if (params.requester !== undefined) {
      columnUpdates.push('requester = COALESCE(?, requester)');
      values.push(params.requester || null);
    }
    if (params.resultBlobId !== undefined) {
      columnUpdates.push('result_blob_id = COALESCE(?, result_blob_id)');
      values.push(params.resultBlobId || null);
    }
    if (params.price !== undefined) {
      columnUpdates.push('price = COALESCE(?, price)');
      values.push(params.price?.toString() ?? null);
    }
    if (params.paymentScheme !== undefined) {
      columnUpdates.push('payment_scheme = COALESCE(?, payment_scheme)');
      values.push(params.paymentScheme ?? null);
    }
    if (params.meteredUnits !== undefined) {
      columnUpdates.push('metered_units = COALESCE(?, metered_units)');
      values.push(params.meteredUnits);
    }
    if (params.maxPrice !== undefined) {
      columnUpdates.push('max_price = COALESCE(?, max_price)');
      values.push(params.maxPrice?.toString() ?? null);
    }
    if (params.unitPrice !== undefined) {
      columnUpdates.push('unit_price = COALESCE(?, unit_price)');
      values.push(params.unitPrice?.toString() ?? null);
    }
    if (params.verificationHash !== undefined) {
      columnUpdates.push('verification_hash = COALESCE(?, verification_hash)');
      values.push(params.verificationHash || null);
    }

    switch (params.status) {
      case TaskStatus.ACCEPTED:
        columnUpdates.push('accepted_at = ?', 'accepted_tx_digest = ?');
        values.push(params.timestampMs, params.txDigest);
        break;
      case TaskStatus.COMPLETED:
        columnUpdates.push('completed_at = ?', 'completed_tx_digest = ?');
        values.push(params.timestampMs, params.txDigest);
        break;
      case TaskStatus.RELEASED:
        columnUpdates.push('released_at = ?', 'released_tx_digest = ?');
        values.push(params.timestampMs, params.txDigest);
        break;
      case TaskStatus.DISPUTED:
        columnUpdates.push('disputed_at = ?', 'disputed_tx_digest = ?');
        values.push(params.timestampMs, params.txDigest);
        break;
      case TaskStatus.CANCELLED:
        columnUpdates.push('cancelled_at = ?', 'cancelled_tx_digest = ?');
        values.push(params.timestampMs, params.txDigest);
        break;
      default:
        break;
    }

    this.db.prepare(`UPDATE tasks SET ${columnUpdates.join(', ')} WHERE id = ?`).run(...values, params.taskId);
    this.recordTaskTransition(params.taskId, params.eventType, params.status, params.txDigest, params.timestampMs, params.payload);
  }

  getTask(taskId: string, includeTransitions = true): IndexedTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!row) {
      return null;
    }
    return mapTaskRow(row, includeTransitions ? this.getTaskTransitions(taskId) : undefined);
  }

  queryTasks(filters: TaskQueryFilters = {}): IndexedTask[] {
    const limit = normalizeLimit(filters.limit, 20);
    const clauses: string[] = [];
    const values: Array<number | string> = [];
    if (filters.status !== undefined) {
      clauses.push('status = ?');
      values.push(filters.status);
    }
    if (filters.requester) {
      clauses.push('requester = ?');
      values.push(filters.requester);
    }
    if (filters.provider) {
      clauses.push('provider = ?');
      values.push(filters.provider);
    }
    if (filters.category) {
      clauses.push('category = ?');
      values.push(filters.category);
    }
    const cursor = decodeCursor(filters.after);
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...values, limit) as TaskRow[];
    return rows.map((row) => mapTaskRow(row));
  }

  getTaskTransitions(taskId: string): IndexedTaskTransition[] {
    const rows = this.db
      .prepare(
        'SELECT task_id, event_type, status, tx_digest, timestamp_ms, payload_json FROM task_transitions WHERE task_id = ? ORDER BY timestamp_ms ASC, id ASC',
      )
      .all(taskId) as TransitionRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      eventType: row.event_type,
      status: Number(row.status) as TaskStatus,
      txDigest: row.tx_digest,
      timestampMs: Number(row.timestamp_ms),
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  upsertBid(bid: Bid): void {
    const existing = this.db.prepare('SELECT 1 FROM bids WHERE id = ?').get(bid.id);
    this.db
      .prepare(
        `INSERT INTO bids (
          id, task_id, bidder, bid_price, reputation_score, evidence_blob, created_at, accepted_at, rejected_at, withdrawn_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          bidder = excluded.bidder,
          bid_price = excluded.bid_price,
          reputation_score = excluded.reputation_score,
          evidence_blob = excluded.evidence_blob,
          created_at = excluded.created_at,
          status = excluded.status`,
      )
      .run(
        bid.id,
        bid.taskId,
        bid.bidder,
        bid.bidPrice.toString(),
        bid.reputationScore.toString(),
        bid.evidenceBlob ?? null,
        bid.createdAt,
        null,
        null,
        null,
        bid.status,
      );
    if (!existing) {
      this.db.prepare('UPDATE tasks SET bid_count = bid_count + 1 WHERE id = ?').run(bid.taskId);
    }
  }

  updateBidStatus(bidId: string, status: BidStatus, timestampMs: number): void {
    const columns: string[] = ['status = ?'];
    const values: Array<number | string> = [status];
    if (status === BidStatus.ACCEPTED) {
      columns.push('accepted_at = ?');
      values.push(timestampMs);
    } else if (status === BidStatus.REJECTED) {
      columns.push('rejected_at = ?');
      values.push(timestampMs);
    } else if (status === BidStatus.WITHDRAWN) {
      columns.push('withdrawn_at = ?');
      values.push(timestampMs);
    }
    this.db.prepare(`UPDATE bids SET ${columns.join(', ')} WHERE id = ?`).run(...values, bidId);
  }

  getBids(taskId: string, status?: BidStatus): Bid[] {
    const rows = (status === undefined
      ? this.db.prepare('SELECT * FROM bids WHERE task_id = ? ORDER BY created_at DESC').all(taskId)
      : this.db.prepare('SELECT * FROM bids WHERE task_id = ? AND status = ? ORDER BY created_at DESC').all(taskId, status)) as BidRow[];
    return rows.map(mapBidRow);
  }

  upsertDispute(dispute: Dispute): void {
    this.db
      .prepare(
        `INSERT INTO disputes (
          id, task_id, requester, provider, escrow_amount, status, requester_evidence_blob,
          provider_evidence_blob, requester_proposed_split, provider_proposed_split, arbitrator,
          ruling_split, opened_at, responded_at, resolved_at, resolution_deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          requester = excluded.requester,
          provider = excluded.provider,
          escrow_amount = excluded.escrow_amount,
          status = excluded.status,
          requester_evidence_blob = excluded.requester_evidence_blob,
          provider_evidence_blob = COALESCE(excluded.provider_evidence_blob, disputes.provider_evidence_blob),
          requester_proposed_split = excluded.requester_proposed_split,
          provider_proposed_split = COALESCE(excluded.provider_proposed_split, disputes.provider_proposed_split),
          arbitrator = COALESCE(excluded.arbitrator, disputes.arbitrator),
          ruling_split = COALESCE(excluded.ruling_split, disputes.ruling_split),
          opened_at = excluded.opened_at,
          responded_at = COALESCE(excluded.responded_at, disputes.responded_at),
          resolved_at = COALESCE(excluded.resolved_at, disputes.resolved_at),
          resolution_deadline = excluded.resolution_deadline`,
      )
      .run(
        dispute.id,
        dispute.taskId,
        dispute.requester,
        dispute.provider,
        dispute.escrowAmount.toString(),
        dispute.status,
        dispute.requesterEvidenceBlob,
        dispute.providerEvidenceBlob ?? null,
        dispute.requesterProposedSplit.toString(),
        dispute.providerProposedSplit.toString(),
        dispute.arbitrator ?? null,
        dispute.rulingSplit.toString(),
        dispute.openedAt,
        dispute.respondedAt ?? null,
        dispute.resolvedAt ?? null,
        dispute.resolutionDeadline,
      );
  }

  updateDispute(params: {
    disputeId: string;
    status: DisputeStatus;
    respondedAt?: number;
    resolvedAt?: number;
    providerEvidenceBlob?: string;
    providerProposedSplit?: bigint;
    arbitrator?: string;
    rulingSplit?: bigint;
  }): void {
    const clauses: string[] = ['status = ?'];
    const values: Array<number | string | null> = [params.status];
    if (params.respondedAt !== undefined) {
      clauses.push('responded_at = ?');
      values.push(params.respondedAt);
    }
    if (params.resolvedAt !== undefined) {
      clauses.push('resolved_at = ?');
      values.push(params.resolvedAt);
    }
    if (params.providerEvidenceBlob !== undefined) {
      clauses.push('provider_evidence_blob = ?');
      values.push(params.providerEvidenceBlob);
    }
    if (params.providerProposedSplit !== undefined) {
      clauses.push('provider_proposed_split = ?');
      values.push(params.providerProposedSplit.toString());
    }
    if (params.arbitrator !== undefined) {
      clauses.push('arbitrator = ?');
      values.push(params.arbitrator);
    }
    if (params.rulingSplit !== undefined) {
      clauses.push('ruling_split = ?');
      values.push(params.rulingSplit.toString());
    }
    this.db.prepare(`UPDATE disputes SET ${clauses.join(', ')} WHERE id = ?`).run(...values, params.disputeId);
  }

  getDisputes(filters: DisputeQueryFilters = {}): Dispute[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filters.status !== undefined) {
      clauses.push('status = ?');
      values.push(filters.status);
    }
    if (filters.agent) {
      clauses.push('(requester = ? OR provider = ? OR arbitrator = ?)');
      values.push(filters.agent, filters.agent, filters.agent);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM disputes ${where} ORDER BY opened_at DESC`).all(...values) as DisputeRow[];
    return rows.map(mapDisputeRow);
  }

  upsertStake(params: {
    stakeId: string;
    owner: string;
    amountMist?: bigint;
    stakeType?: 'agent' | 'relay';
    stakedAt?: number;
    deactivatedAt?: number;
    withdrawnAt?: number;
    slashedAmountMist?: bigint;
    active?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO stakes (
          id, owner, amount_mist, active, stake_type, staked_at, deactivated_at, withdrawn_at, slashed_amount_mist, last_updated_at
        ) VALUES (?, ?, COALESCE(?, (SELECT amount_mist FROM stakes WHERE id = ?), '0'), ?, ?, ?, ?, ?, COALESCE(?, (SELECT slashed_amount_mist FROM stakes WHERE id = ?), '0'), ?)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          amount_mist = COALESCE(excluded.amount_mist, stakes.amount_mist),
          active = excluded.active,
          stake_type = COALESCE(excluded.stake_type, stakes.stake_type),
          staked_at = COALESCE(excluded.staked_at, stakes.staked_at),
          deactivated_at = COALESCE(excluded.deactivated_at, stakes.deactivated_at),
          withdrawn_at = COALESCE(excluded.withdrawn_at, stakes.withdrawn_at),
          slashed_amount_mist = COALESCE(excluded.slashed_amount_mist, stakes.slashed_amount_mist),
          last_updated_at = excluded.last_updated_at`,
      )
      .run(
        params.stakeId,
        params.owner,
        params.amountMist?.toString() ?? null,
        params.stakeId,
        params.active === false ? 0 : 1,
        params.stakeType ?? null,
        params.stakedAt ?? null,
        params.deactivatedAt ?? null,
        params.withdrawnAt ?? null,
        params.slashedAmountMist?.toString() ?? null,
        params.stakeId,
        Date.now(),
      );
    this.syncAgentStake(params.owner);
  }

  addStakeSlash(stakeId: string, amountMist: bigint): void {
    this.db
      .prepare(
        `UPDATE stakes
         SET slashed_amount_mist = add_bigint(slashed_amount_mist, ?),
             amount_mist = subtract_bigint(amount_mist, ?),
             last_updated_at = ?
         WHERE id = ?`,
      )
      .run(amountMist.toString(), amountMist.toString(), Date.now(), stakeId);
    const owner = this.db.prepare('SELECT owner FROM stakes WHERE id = ?').get(stakeId) as { owner: string } | undefined;
    if (owner) {
      this.syncAgentStake(owner.owner);
    }
  }

  upsertReputationAnchor(params: {
    anchorId: string;
    author: string;
    merkleRoot: string;
    eventCount: number;
    blobId?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    createdAt: number;
    txDigest: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reputation_anchors (
          anchor_id, author, merkle_root, event_count, blob_id, from_timestamp, to_timestamp, created_at, tx_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.anchorId,
        params.author,
        params.merkleRoot,
        params.eventCount,
        params.blobId ?? null,
        params.fromTimestamp ?? null,
        params.toTimestamp ?? null,
        params.createdAt,
        params.txDigest,
      );
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private recordTaskTransition(
    taskId: string,
    eventType: string,
    status: TaskStatus,
    txDigest: string,
    timestampMs: number,
    payload: Record<string, unknown>,
  ): void {
    const exists = this.db
      .prepare('SELECT 1 FROM task_transitions WHERE task_id = ? AND event_type = ? AND tx_digest = ? LIMIT 1')
      .get(taskId, eventType, txDigest);
    if (exists) {
      return;
    }

    this.db
      .prepare(
        'INSERT INTO task_transitions (task_id, event_type, status, tx_digest, timestamp_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, eventType, status, txDigest, timestampMs, JSON.stringify(payload, bigintReplacer));
  }

  private syncAgentStake(owner: string): void {
    const stake = this.db
      .prepare('SELECT amount_mist, active, stake_type FROM stakes WHERE owner = ? ORDER BY last_updated_at DESC LIMIT 1')
      .get(owner) as { amount_mist: string; active: number | bigint; stake_type: string | null } | undefined;
    if (!stake) {
      this.db.prepare('UPDATE agents SET has_stake = 0, stake_mist = NULL, stake_type = NULL WHERE owner = ?').run(owner);
      return;
    }
    this.db
      .prepare('UPDATE agents SET has_stake = ?, stake_mist = ?, stake_type = ? WHERE owner = ?')
      .run(Number(stake.active) === 1 ? 1 : 0, stake.amount_mist, stake.stake_type, owner);
  }
}

export function encodeCursor(task: Pick<Task, 'id' | 'createdAt'>): string {
  return Buffer.from(JSON.stringify({ id: task.id, createdAt: task.createdAt })).toString('base64url');
}

function decodeCursor(cursor?: string): { id: string; createdAt: number } | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: string; createdAt?: number };
    return typeof parsed.id === 'string' && typeof parsed.createdAt === 'number'
      ? { id: parsed.id, createdAt: parsed.createdAt }
      : null;
  } catch {
    return null;
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

function mapTaskRow(row: TaskRow, transitions?: IndexedTaskTransition[]): IndexedTask {
  return {
    id: row.id,
    requester: row.requester,
    provider: row.provider ?? undefined,
    capability: row.capability,
    category: row.category,
    inputBlobId: row.input_blob_id,
    resultBlobId: row.result_blob_id ?? undefined,
    price: BigInt(row.price),
    paymentScheme: normalizePaymentScheme(row.payment_scheme),
    maxPrice: row.max_price == null ? undefined : BigInt(row.max_price),
    meteredUnits: row.metered_units == null ? undefined : Number(row.metered_units),
    unitPrice: row.unit_price == null ? undefined : BigInt(row.unit_price),
    verificationHash: row.verification_hash ?? undefined,
    status: Number(row.status) as TaskStatus,
    disputeWindowMs: Number(row.dispute_window_ms ?? 0),
    createdAt: Number(row.created_at),
    acceptedAt: row.accepted_at == null ? undefined : Number(row.accepted_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    releasedAt: row.released_at == null ? undefined : Number(row.released_at),
    disputedAt: row.disputed_at == null ? undefined : Number(row.disputed_at),
    cancelledAt: row.cancelled_at == null ? undefined : Number(row.cancelled_at),
    expiresAt: Number(row.expires_at),
    agreementHash: row.agreement_hash ?? undefined,
    bidCount: Number(row.bid_count ?? 0),
    gasCostMistTotal: BigInt(row.gas_cost_mist_total ?? '0'),
    transitions,
  };
}

function mapBidRow(row: BidRow): Bid {
  return {
    id: row.id,
    taskId: row.task_id,
    bidder: row.bidder,
    bidPrice: BigInt(row.bid_price),
    reputationScore: BigInt(row.reputation_score),
    evidenceBlob: row.evidence_blob ?? undefined,
    createdAt: Number(row.created_at),
    status: Number(row.status) as BidStatus,
  };
}

function mapDisputeRow(row: DisputeRow): Dispute {
  return {
    id: row.id,
    taskId: row.task_id,
    requester: row.requester,
    provider: row.provider,
    escrowAmount: BigInt(row.escrow_amount),
    status: Number(row.status) as DisputeStatus,
    requesterEvidenceBlob: row.requester_evidence_blob,
    providerEvidenceBlob: row.provider_evidence_blob ?? undefined,
    requesterProposedSplit: BigInt(row.requester_proposed_split),
    providerProposedSplit: BigInt(row.provider_proposed_split),
    arbitrator: row.arbitrator ?? undefined,
    rulingSplit: BigInt(row.ruling_split),
    openedAt: Number(row.opened_at),
    respondedAt: row.responded_at == null ? undefined : Number(row.responded_at),
    resolvedAt: row.resolved_at == null ? undefined : Number(row.resolved_at),
    resolutionDeadline: Number(row.resolution_deadline),
  };
}

function parseCapabilities(value: string | null): Capability[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as Array<Capability & { pricing: Capability['pricing'] & { amount: string } }>;
    return parsed.map((entry) => ({
      ...entry,
      pricing: {
        ...entry.pricing,
        amount: BigInt(entry.pricing.amount),
      },
    }));
  } catch {
    return [];
  }
}

function buildCapabilitiesText(capabilities: Capability[]): string {
  return capabilities.map((entry) => `${entry.name} ${entry.description} ${entry.version}`).join(' ');
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' OR ');
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

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function normalizePaymentScheme(value: string | null): PaymentScheme | undefined {
  switch (value) {
    case PaymentScheme.EXACT:
      return PaymentScheme.EXACT;
    case PaymentScheme.UPTO:
      return PaymentScheme.UPTO;
    case PaymentScheme.STREAM:
      return PaymentScheme.STREAM;
    default:
      return undefined;
  }
}

function ensureTaskColumns(db: Database.Database): void {
  const rows = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name?: string }>;
  const existing = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
  const missingColumns = [
    ['payment_scheme', 'TEXT'],
    ['max_price', 'TEXT'],
    ['metered_units', 'INTEGER'],
    ['unit_price', 'TEXT'],
    ['verification_hash', 'TEXT'],
  ] as const;

  for (const [column, type] of missingColumns) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
    }
  }
}
