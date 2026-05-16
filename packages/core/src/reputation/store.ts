import Database from 'better-sqlite3';

import type { ReputationEvent } from '@hivemind-os/collective-types';

import { assertValidReputationEvent, parseReputationEvent } from './validation.js';

interface ReputationEventRow {
  payload_json: string;
}

export class ReputationStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.defaultSafeIntegers(true);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reputation_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        author TEXT NOT NULL,
        task_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        rating INTEGER,
        capability TEXT NOT NULL,
        payment_amount TEXT,
        payment_currency TEXT,
        latency_ms INTEGER,
        timestamp TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        anchor_id TEXT,
        anchored_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reputation_events_subject_idx ON reputation_events (subject, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS reputation_events_author_idx ON reputation_events (author, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS reputation_events_anchor_idx ON reputation_events (anchor_id);
    `);
  }

  async addEvent(event: ReputationEvent): Promise<void> {
    const validated = assertValidReputationEvent(event);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reputation_events (
          event_id, type, subject, author, task_id, outcome, rating, capability,
          payment_amount, payment_currency, latency_ms, timestamp, timestamp_ms,
          nonce, signature, payload_json, anchor_id, anchored_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT anchor_id FROM reputation_events WHERE event_id = ?), NULL), COALESCE((SELECT anchored_at FROM reputation_events WHERE event_id = ?), NULL), ?)`
      )
      .run(
        validated.eventId,
        validated.type,
        validated.subject,
        validated.author,
        validated.taskId,
        validated.outcome,
        validated.rating ?? null,
        validated.capability,
        validated.paymentAmount?.amount ?? null,
        validated.paymentAmount?.currency ?? null,
        validated.latencyMs ?? null,
        validated.timestamp,
        toTimestampMs(validated.timestamp),
        validated.nonce,
        validated.signature,
        JSON.stringify(validated),
        validated.eventId,
        validated.eventId,
        Date.now(),
      );
  }

  async getEvents(options: { subject?: string; author?: string; since?: number; limit?: number }): Promise<ReputationEvent[]> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.subject) {
      clauses.push('subject = ?');
      values.push(options.subject);
    }
    if (options.author) {
      clauses.push('author = ?');
      values.push(options.author);
    }
    if (typeof options.since === 'number') {
      clauses.push('timestamp_ms >= ?');
      values.push(Math.max(0, Math.floor(options.since)));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT payload_json FROM reputation_events ${where} ORDER BY timestamp_ms DESC LIMIT ?`)
      .all(...values, normalizeLimit(options.limit)) as ReputationEventRow[];
    return rows
      .map((row) => parseStoredEvent(row.payload_json))
      .filter((event): event is ReputationEvent => Boolean(event));
  }

  async getUnanchoredEvents(limit = 100): Promise<ReputationEvent[]> {
    const rows = this.db
      .prepare('SELECT payload_json FROM reputation_events WHERE anchor_id IS NULL ORDER BY timestamp_ms ASC LIMIT ?')
      .all(normalizeLimit(limit)) as ReputationEventRow[];
    return rows
      .map((row) => parseStoredEvent(row.payload_json))
      .filter((event): event is ReputationEvent => Boolean(event));
  }

  async markAnchored(eventIds: string[], anchorId: string): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }

    const placeholders = eventIds.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE reputation_events SET anchor_id = ?, anchored_at = ? WHERE event_id IN (${placeholders})`)
      .run(anchorId, Date.now(), ...eventIds);
  }

  async getStats(subject: string): Promise<{ completed: number; failed: number; disputed: number }> {
    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN outcome IN ('failure', 'timeout', 'cancelled') THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN type = 'dispute_opened' OR outcome = 'disputed' THEN 1 ELSE 0 END) AS disputed
         FROM reputation_events
         WHERE subject = ?`,
      )
      .get(subject) as { completed?: number | bigint | null; failed?: number | bigint | null; disputed?: number | bigint | null } | undefined;

    return {
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
      disputed: Number(row?.disputed ?? 0),
    };
  }

  close(): void {
    this.db.close();
  }
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 100;
  }
  return Math.max(1, Math.floor(limit));
}

function toTimestampMs(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function parseStoredEvent(payloadJson: string): ReputationEvent | null {
  try {
    return parseReputationEvent(JSON.parse(payloadJson) as unknown);
  } catch {
    return null;
  }
}
