import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskEntry {
  taskId: string;
  onChainTaskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
  result?: CallToolResult;
  progressToken?: string | number;
}

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Per-session in-memory store mapping MCP task IDs to on-chain task IDs.
 * Tracks lifecycle state for each task and enables MCP task protocol support.
 */
export class McpTaskStore {
  private readonly tasks = new Map<string, McpTaskEntry>();
  private readonly chainToMcpId = new Map<string, string>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  create(onChainTaskId: string, options?: { ttl?: number | null; pollInterval?: number; progressToken?: string | number }): McpTaskEntry {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const ttl = options?.ttl !== undefined ? options.ttl : DEFAULT_TTL_MS;

    const entry: McpTaskEntry = {
      taskId,
      onChainTaskId,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttl,
      pollInterval: options?.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
      progressToken: options?.progressToken,
    };

    this.tasks.set(taskId, entry);
    this.chainToMcpId.set(onChainTaskId, taskId);
    this.scheduleCleanup(entry);
    return entry;
  }

  get(taskId: string): McpTaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  getByChainId(onChainTaskId: string): McpTaskEntry | undefined {
    const mcpId = this.chainToMcpId.get(onChainTaskId);
    return mcpId ? this.tasks.get(mcpId) : undefined;
  }

  update(taskId: string, status: McpTaskStatus, options?: { statusMessage?: string; result?: CallToolResult }): McpTaskEntry | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return undefined;
    }

    entry.status = status;
    entry.lastUpdatedAt = new Date().toISOString();
    if (options?.statusMessage !== undefined) {
      entry.statusMessage = options.statusMessage;
    }
    if (options?.result !== undefined) {
      entry.result = options.result;
    }

    // Reschedule cleanup from now on terminal states
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.scheduleCleanup(entry);
    }

    return entry;
  }

  cancel(taskId: string): McpTaskEntry | undefined {
    return this.update(taskId, 'cancelled', { statusMessage: 'Cancelled by client' });
  }

  list(): McpTaskEntry[] {
    return [...this.tasks.values()];
  }

  cleanup(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.tasks.clear();
    this.chainToMcpId.clear();
  }

  private scheduleCleanup(entry: McpTaskEntry): void {
    if (entry.ttl === null) {
      return;
    }

    const existing = this.cleanupTimers.get(entry.taskId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.tasks.delete(entry.taskId);
      this.chainToMcpId.delete(entry.onChainTaskId);
      this.cleanupTimers.delete(entry.taskId);
    }, entry.ttl);

    // Don't keep the process alive for cleanup timers
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }

    this.cleanupTimers.set(entry.taskId, timer);
  }
}
