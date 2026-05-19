import Database from 'better-sqlite3';
import pino from 'pino';

import type { EventId as EventID, SuiEvent } from '@mysten/sui/client';

import { MeshSuiClient } from '../sui/client.js';

const logger = pino({ name: '@hivemind-os/collective-core:events' });

export interface CursorStore {
  getCursor(eventType: string): Promise<EventID | null>;
  setCursor(eventType: string, cursor: EventID): Promise<void>;
}

export class EventSubscription {
  private running = false;
  private timer?: NodeJS.Timeout;
  private cursor: EventID | null = null;
  private polling = false;

  constructor(
    private readonly params: {
      suiClient: MeshSuiClient;
      eventType: string;
      pollIntervalMs?: number;
      onEvent: (event: SuiEvent) => Promise<void>;
      onError?: (error: unknown) => void;
      cursorStore: CursorStore;
    },
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }

    this.polling = true;
    let nextDelay = this.params.pollIntervalMs ?? 5_000;

    try {
      if (!this.cursor) {
        this.cursor = await this.params.cursorStore.getCursor(this.params.eventType);
      }

      const page = await this.params.suiClient.queryEvents(
        this.params.eventType,
        this.cursor,
        100,
      );

      for (const event of page.events) {
        await this.params.onEvent(event);
        try {
          await this.params.cursorStore.setCursor(this.params.eventType, event.id);
          this.cursor = event.id;
        } catch (cursorError) {
          logger.error(
            { err: cursorError, eventType: this.params.eventType },
            'Failed to persist cursor; will retry from last successful position.',
          );
          break;
        }
      }

      if (page.hasMore) {
        nextDelay = 0;
      }
    } catch (error) {
      logger.error({ err: error, eventType: this.params.eventType }, 'Event polling failed.');
      this.params.onError?.(error);
    } finally {
      this.polling = false;
      if (this.running) {
        this.timer = setTimeout(() => {
          void this.poll();
        }, nextDelay);
      }
    }
  }
}

function isValidEventId(value: unknown): value is EventID {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return typeof obj.txDigest === 'string' && typeof obj.eventSeq === 'string';
}

export class SqliteCursorStore implements CursorStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_cursors (
        event_type TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async getCursor(eventType: string): Promise<EventID | null> {
    const row = this.db
      .prepare('SELECT cursor_json FROM event_cursors WHERE event_type = ?')
      .get(eventType) as { cursor_json: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.cursor_json) as unknown;
      if (!isValidEventId(parsed)) {
        logger.warn({ eventType, cursor: row.cursor_json }, 'Invalid cursor format in store, resetting.');
        return null;
      }
      return parsed;
    } catch (error) {
      logger.error({ err: error, eventType }, 'Failed to parse cursor from store.');
      return null;
    }
  }

  async setCursor(eventType: string, cursor: EventID): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO event_cursors (event_type, cursor_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(event_type)
           DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
        )
        .run(eventType, JSON.stringify(cursor), Date.now());
    } catch (error) {
      logger.error({ err: error, eventType }, 'Failed to persist event cursor.');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
