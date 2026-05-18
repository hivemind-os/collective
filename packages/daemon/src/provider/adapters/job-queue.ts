import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import type { ExecutionAdapter } from './interface.js';

export interface WorkItem {
  id: string;
  taskId: string;
  capability: string;
  inputData: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  resultData?: string;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
}

export interface JobQueueConfig {
  dbPath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const decoder = new TextDecoder('utf-8', { fatal: false });

export class JobQueueAdapter implements ExecutionAdapter {
  readonly name = 'job-queue';

  private readonly db: ReturnType<typeof Database>;
  private readonly timeoutMs: number;
  private readonly resolvers = new Map<string, { resolve: (data: Uint8Array) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(config: JobQueueConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        input_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_data TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
      CREATE INDEX IF NOT EXISTS idx_work_items_created ON work_items(created_at);
    `);
  }

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    const id = randomUUID();
    const inputText = decoder.decode(params.inputData);
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO work_items (id, task_id, capability, input_data, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, params.taskId, params.capability, inputText, 'pending', now);

    return new Promise<{ resultData: Uint8Array }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(id);
        this.db.prepare('UPDATE work_items SET status = ?, error = ?, completed_at = ? WHERE id = ?')
          .run('failed', 'Timeout: agent did not complete work item in time', Date.now(), id);
        reject(new Error(`Work item ${id} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.resolvers.set(id, { resolve: (data) => resolve({ resultData: data }), reject, timer });
    });
  }

  poll(): WorkItem | null {
    const row = this.db.prepare(
      'SELECT * FROM work_items WHERE status = ? ORDER BY created_at ASC LIMIT 1',
    ).get('pending') as RawWorkItem | undefined;

    if (!row) return null;

    const now = Date.now();
    this.db.prepare('UPDATE work_items SET status = ?, claimed_at = ? WHERE id = ?')
      .run('claimed', now, row.id);

    return mapRow({ ...row, status: 'claimed', claimed_at: now });
  }

  complete(itemId: string, resultData: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT status FROM work_items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!row) return { ok: false, error: 'Work item not found' };
    if (row.status !== 'claimed') return { ok: false, error: `Cannot complete item in status '${row.status}'` };

    const now = Date.now();
    this.db.prepare('UPDATE work_items SET status = ?, result_data = ?, completed_at = ? WHERE id = ?')
      .run('completed', resultData, now, itemId);

    const resolver = this.resolvers.get(itemId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.resolvers.delete(itemId);
      const encoder = new TextEncoder();
      resolver.resolve(encoder.encode(resultData));
    }

    return { ok: true };
  }

  fail(itemId: string, error: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT status FROM work_items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!row) return { ok: false, error: 'Work item not found' };
    if (row.status !== 'claimed' && row.status !== 'pending') {
      return { ok: false, error: `Cannot fail item in status '${row.status}'` };
    }

    const now = Date.now();
    this.db.prepare('UPDATE work_items SET status = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('failed', error, now, itemId);

    const resolver = this.resolvers.get(itemId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.resolvers.delete(itemId);
      resolver.reject(new Error(error));
    }

    return { ok: true };
  }

  retry(itemId: string): { ok: boolean; error?: string } {
    const row = this.db.prepare('SELECT status FROM work_items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!row) return { ok: false, error: 'Work item not found' };
    if (row.status !== 'failed' && row.status !== 'claimed') {
      return { ok: false, error: `Cannot retry item in status '${row.status}'` };
    }

    this.db.prepare('UPDATE work_items SET status = ?, claimed_at = NULL, completed_at = NULL, error = NULL WHERE id = ?')
      .run('pending', itemId);

    return { ok: true };
  }

  remove(itemId: string): { ok: boolean; error?: string } {
    const result = this.db.prepare('DELETE FROM work_items WHERE id = ?').run(itemId);
    if (result.changes === 0) return { ok: false, error: 'Work item not found' };

    const resolver = this.resolvers.get(itemId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.resolvers.delete(itemId);
      resolver.reject(new Error('Work item was deleted'));
    }

    return { ok: true };
  }

  list(filter?: { status?: string }): WorkItem[] {
    if (filter?.status) {
      const rows = this.db.prepare('SELECT * FROM work_items WHERE status = ? ORDER BY created_at DESC')
        .all(filter.status) as RawWorkItem[];
      return rows.map(mapRow);
    }
    const rows = this.db.prepare('SELECT * FROM work_items ORDER BY created_at DESC')
      .all() as RawWorkItem[];
    return rows.map(mapRow);
  }

  getItem(itemId: string): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as RawWorkItem | undefined;
    return row ? mapRow(row) : null;
  }

  close(): void {
    for (const [id, resolver] of this.resolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error('Job queue adapter closed'));
      this.resolvers.delete(id);
    }
    this.db.close();
  }
}

interface RawWorkItem {
  id: string;
  task_id: string;
  capability: string;
  input_data: string;
  status: string;
  result_data: string | null;
  error: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

function mapRow(row: RawWorkItem): WorkItem {
  return {
    id: row.id,
    taskId: row.task_id,
    capability: row.capability,
    inputData: row.input_data,
    status: row.status as WorkItem['status'],
    resultData: row.result_data ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}
