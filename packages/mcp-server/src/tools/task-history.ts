import type { MeshToolContext } from '../context.js';

export interface MeshTaskHistoryParams {
  limit?: number;
  status_filter?: string;
}

export const meshTaskHistoryTool = {
  name: 'collective_task_history',
  description: 'Query locally persisted task history',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max task rows to return (default 20)' },
      status_filter: { type: 'string', description: 'Optional task status filter' },
    },
    required: [],
  },
};

export async function runMeshTaskHistory(
  params: MeshTaskHistoryParams,
  context: MeshToolContext,
): Promise<{ tasks: unknown[]; note?: string }> {
  const db = context.taskHistoryDb as
    | {
        prepare?: (sql: string) => {
          all: (...args: unknown[]) => unknown[];
        };
      }
    | undefined;

  if (!db?.prepare) {
    return {
      tasks: [],
      note: 'Local task history is not initialized yet.',
    };
  }

  const limit = normalizeLimit(params.limit);
  const statusFilter = params.status_filter?.trim();

  try {
    const statement = statusFilter
      ? db.prepare(
          'SELECT * FROM task_history WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        )
      : db.prepare('SELECT * FROM task_history ORDER BY created_at DESC LIMIT ?');
    const rows = statusFilter ? statement.all(statusFilter, limit) : statement.all(limit);

    return {
      tasks: rows.map((row) => serializeBigInts(row)),
    };
  } catch {
    return {
      tasks: [],
      note: 'Local task history database is not available yet.',
    };
  }
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 20;
  }

  return Math.max(1, Math.floor(limit));
}

function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeBigInts(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeBigInts(entry)]),
    );
  }

  return value;
}
