import { BidStatus } from '@hivemind-os/collective-types';

import type { IndexerStore, ProviderStatsRecord } from './store.js';

export type TimePeriod = 'hour' | 'day' | 'week';
export type ProviderSortField = 'completedTasks' | 'earnings' | 'reputation';

export interface TimeBucket {
  label: string;
  count: number;
  volumeMist: bigint;
}

export interface GasCostStat {
  capability: string;
  averageGasMist: bigint;
  taskCount: number;
}

export interface CategoryPopularity {
  category: string;
  taskCount: number;
}

export interface MarketplaceStats {
  averageBidCount: number;
  acceptanceRate: number;
  categoryPopularity: CategoryPopularity[];
}

export interface ReputationTrend {
  label: string;
  completed: number;
  failed: number;
  disputed: number;
  successRate: number;
}

export interface AnalyticsSummary {
  totalAgents: number;
  activeAgents: number;
  totalTasks: number;
  completedTasks: number;
  disputedTasks: number;
  totalVolumeMist: bigint;
  averageGasCosts: GasCostStat[];
  marketplace: MarketplaceStats;
}

export class AnalyticsEngine {
  constructor(private readonly store: IndexerStore) {}

  getSummary(): AnalyticsSummary {
    const db = this.store.getDatabase();
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS total_agents,
           SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_agents,
           COALESCE((SELECT COUNT(*) FROM tasks), 0) AS total_tasks,
           COALESCE((SELECT SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) FROM tasks), 0) AS completed_tasks,
           COALESCE((SELECT SUM(CASE WHEN disputed_at IS NOT NULL THEN 1 ELSE 0 END) FROM tasks), 0) AS disputed_tasks
         FROM agents`,
      )
      .get() as {
      total_agents?: number | bigint | null;
      active_agents?: number | bigint | null;
      total_tasks?: number | bigint | null;
      completed_tasks?: number | bigint | null;
      disputed_tasks?: number | bigint | null;
    };

    return {
      totalAgents: Number(totals.total_agents ?? 0),
      activeAgents: Number(totals.active_agents ?? 0),
      totalTasks: Number(totals.total_tasks ?? 0),
      completedTasks: Number(totals.completed_tasks ?? 0),
      disputedTasks: Number(totals.disputed_tasks ?? 0),
      totalVolumeMist: sumBigIntRows(db.prepare('SELECT price FROM tasks').all() as Array<{ price: string | number | bigint | null }>),
      averageGasCosts: this.getAverageGasCostsByTaskType(),
      marketplace: this.getMarketplaceStats(),
    };
  }

  getTaskVolume(period: TimePeriod = 'day', buckets = 14): TimeBucket[] {
    const db = this.store.getDatabase();
    const rows = db
      .prepare(
        `SELECT ${bucketSql(period)} AS label, created_at, price
         FROM tasks
         ORDER BY created_at DESC`,
      )
      .all() as Array<{ label: string; created_at: number | bigint; price: string | number | bigint | null }>;

    const grouped = new Map<string, { count: number; volumeMist: bigint; createdAt: number }>();
    for (const row of rows) {
      const current = grouped.get(row.label) ?? { count: 0, volumeMist: 0n, createdAt: Number(row.created_at) };
      current.count += 1;
      current.volumeMist += toBigInt(row.price);
      current.createdAt = Math.min(current.createdAt, Number(row.created_at));
      grouped.set(row.label, current);
    }

    return [...grouped.entries()]
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, normalizeBucketCount(buckets))
      .reverse()
      .map(([label, row]) => ({
        label,
        count: row.count,
        volumeMist: row.volumeMist,
      }));
  }

  getAverageGasCostsByTaskType(): GasCostStat[] {
    const db = this.store.getDatabase();
    const rows = db
      .prepare(
        `SELECT capability, gas_cost_mist_total
         FROM tasks
         ORDER BY capability ASC`,
      )
      .all() as Array<{ capability: string; gas_cost_mist_total: string | number | bigint | null }>;

    const grouped = new Map<string, { total: bigint; count: number }>();
    for (const row of rows) {
      const current = grouped.get(row.capability) ?? { total: 0n, count: 0 };
      current.total += toBigInt(row.gas_cost_mist_total);
      current.count += 1;
      grouped.set(row.capability, current);
    }

    return [...grouped.entries()]
      .map(([capability, stats]) => ({
        capability,
        averageGasMist: stats.count === 0 ? 0n : stats.total / BigInt(stats.count),
        taskCount: stats.count,
      }))
      .sort((left, right) => compareNumber(right.taskCount, left.taskCount) || left.capability.localeCompare(right.capability));
  }

  getMarketplaceStats(): MarketplaceStats {
    const db = this.store.getDatabase();
    const aggregates = db
      .prepare(
        `SELECT
           COALESCE(AVG(bid_count), 0) AS average_bid_count,
           COALESCE((SELECT CAST(SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) FROM bids), 0) AS acceptance_rate
         FROM tasks`,
      )
      .get(BidStatus.ACCEPTED) as { average_bid_count?: number | bigint | null; acceptance_rate?: number | null };

    const categories = db
      .prepare('SELECT category, COUNT(*) AS task_count FROM tasks GROUP BY category ORDER BY task_count DESC, category ASC')
      .all() as Array<{ category: string; task_count: number | bigint }>;

    return {
      averageBidCount: Number(aggregates.average_bid_count ?? 0),
      acceptanceRate: Number(aggregates.acceptance_rate ?? 0),
      categoryPopularity: categories.map((row) => ({ category: row.category, taskCount: Number(row.task_count) })),
    };
  }

  getReputationTrends(agentDid: string, period: TimePeriod = 'day', buckets = 12): ReputationTrend[] {
    const agent = this.store.getAgentByDid(agentDid);
    if (!agent) {
      return [];
    }

    const db = this.store.getDatabase();
    const rows = db
      .prepare(
        `SELECT
           ${bucketSql(period)} AS label,
           created_at,
           completed_at,
           disputed_at
         FROM tasks
         WHERE provider = ?
         ORDER BY created_at DESC`,
      )
      .all(agent.owner) as Array<{
      label: string;
      created_at: number | bigint;
      completed_at: number | bigint | null;
      disputed_at: number | bigint | null;
    }>;

    const grouped = new Map<string, { completed: number; failed: number; disputed: number; createdAt: number }>();
    for (const row of rows) {
      const current = grouped.get(row.label) ?? { completed: 0, failed: 0, disputed: 0, createdAt: Number(row.created_at) };
      if (row.disputed_at != null) {
        current.failed += 1;
        current.disputed += 1;
      } else if (row.completed_at != null) {
        current.completed += 1;
      }
      current.createdAt = Math.min(current.createdAt, Number(row.created_at));
      grouped.set(row.label, current);
    }

    return [...grouped.entries()]
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, normalizeBucketCount(buckets))
      .reverse()
      .map(([label, row]) => ({
        label,
        completed: row.completed,
        failed: row.failed,
        disputed: row.disputed,
        successRate: row.completed + row.failed === 0 ? 0 : row.completed / (row.completed + row.failed),
      }));
  }

  getTopProviders(limit = 10, sortBy: ProviderSortField = 'completedTasks'): ProviderStatsRecord[] {
    const db = this.store.getDatabase();
    const rows = db
      .prepare(
        `SELECT
           did,
           owner,
           name,
           COALESCE(total_tasks_completed, 0) AS completed_tasks,
           COALESCE(total_tasks_failed, 0) AS failed_tasks,
           COALESCE(total_tasks_disputed, 0) AS dispute_count,
           COALESCE(total_earnings_mist, '0') AS earnings_mist
         FROM agents
         WHERE active = 1
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      did: string;
      owner: string;
      name: string;
      completed_tasks: number | bigint | null;
      failed_tasks: number | bigint | null;
      dispute_count: number | bigint | null;
      earnings_mist: string | null;
    }>;

    const scored = rows.map((row) => {
      const completedTasks = Number(row.completed_tasks ?? 0);
      const failedTasks = Number(row.failed_tasks ?? 0);
      const disputeCount = Number(row.dispute_count ?? 0);
      const earningsMist = BigInt(row.earnings_mist ?? '0');
      const successRate = completedTasks + failedTasks === 0 ? 0 : completedTasks / (completedTasks + failedTasks);
      const reputation = successRate * 100 + completedTasks + Number(earningsMist > 0n ? 1n : 0n) - disputeCount;
      return {
        did: row.did,
        owner: row.owner,
        name: row.name,
        completedTasks,
        earningsMist,
        disputeCount,
        successRate,
        reputation,
      } satisfies ProviderStatsRecord;
    });

    return [...scored]
      .sort((left, right) => {
        if (sortBy === 'earnings') {
          return compareBigInt(right.earningsMist, left.earningsMist) || compareNumber(right.completedTasks, left.completedTasks);
        }
        if (sortBy === 'reputation') {
          return compareNumber(right.reputation, left.reputation) || compareNumber(right.completedTasks, left.completedTasks);
        }
        return compareNumber(right.completedTasks, left.completedTasks) || compareBigInt(right.earningsMist, left.earningsMist);
      })
      .slice(0, Math.max(1, Math.floor(limit)));
  }
}

function normalizeBucketCount(buckets: number): number {
  return Number.isFinite(buckets) ? Math.max(1, Math.floor(buckets)) : 14;
}

function bucketSql(period: TimePeriod): string {
  switch (period) {
    case 'hour':
      return "strftime('%Y-%m-%dT%H:00:00Z', created_at / 1000, 'unixepoch')";
    case 'week':
      return "strftime('%Y-W%W', created_at / 1000, 'unixepoch')";
    case 'day':
    default:
      return "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')";
  }
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function sumBigIntRows(rows: Array<{ price: string | number | bigint | null }>): bigint {
  return rows.reduce((sum, row) => sum + toBigInt(row.price), 0n);
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
