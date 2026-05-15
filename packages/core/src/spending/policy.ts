import Database from 'better-sqlite3';

import type { PaymentRail, SpendingPolicy } from '@agentic-mesh/types';

export interface SpendingPolicyDecision {
  approved: boolean;
  reason?: string;
}

export interface SpendingPolicyConfig extends SpendingPolicy {
  perApp?: Record<string, { limits: SpendingPolicy['limits'] }>;
}

interface SpendingLogRow {
  total: bigint | number | null;
}

export class SpendingPolicyEngine {
  private readonly db: Database.Database;
  private policy: SpendingPolicyConfig;

  constructor(params: { policy: SpendingPolicyConfig; dbPath: string }) {
    this.policy = params.policy;
    this.db = new Database(params.dbPath);
    this.db.defaultSafeIntegers(true);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spending_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_mist INTEGER NOT NULL,
        rail TEXT NOT NULL,
        task_id TEXT,
        app_id TEXT,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  evaluate(request: {
    amountMist: bigint;
    rail: PaymentRail;
    appId?: string;
    originAppName?: string;
  }): SpendingPolicyDecision {
    const originAppName = request.originAppName;
    const perAppPolicy = originAppName ? this.policy.perApp?.[originAppName] : undefined;
    if (perAppPolicy) {
      const perAppDecision = this.evaluateLimits(perAppPolicy.limits, request, originAppName);
      if (!perAppDecision.approved) {
        return perAppDecision;
      }
    }

    if (this.policy.denylist?.includes(request.appId ?? '')) {
      return { approved: false, reason: 'App is denylisted.' };
    }

    if (this.policy.allowlist && !this.policy.allowlist.includes(request.appId ?? '')) {
      return { approved: false, reason: 'App is not allowlisted.' };
    }

    if (
      this.policy.requireConfirmationAbove !== undefined &&
      request.amountMist > this.policy.requireConfirmationAbove
    ) {
      return { approved: false, reason: 'Amount requires confirmation.' };
    }

    return this.evaluateLimits(this.policy.limits, request);
  }

  record(entry: {
    amountMist: bigint;
    rail: PaymentRail;
    taskId: string;
    appId?: string;
    originAppName?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO spending_log (amount_mist, rail, task_id, app_id, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.amountMist, entry.rail, entry.taskId, entry.originAppName ?? entry.appId ?? null, Date.now());
  }

  getSpent(interval: 'hour' | 'day' | 'month', rail?: PaymentRail, appId?: string): bigint {
    return this.getSpentForLimit(interval, rail, appId);
  }

  updatePolicy(policy: SpendingPolicyConfig): void {
    this.policy = policy;
  }

  close(): void {
    this.db.close();
  }

  private evaluateLimits(
    limits: SpendingPolicy['limits'],
    request: {
      amountMist: bigint;
      rail: PaymentRail;
      appId?: string;
    },
    appScope?: string,
  ): SpendingPolicyDecision {
    for (const limit of limits) {
      if (limit.rail && limit.rail !== request.rail) {
        continue;
      }

      const scope = appScope ?? limit.scope;
      if (!appScope && limit.scope && limit.scope !== request.appId) {
        continue;
      }

      if (limit.interval === 'transaction' && request.amountMist > limit.amount) {
        return { approved: false, reason: `Transaction limit exceeded for ${limit.interval}.` };
      }

      if (limit.interval === 'transaction') {
        continue;
      }

      const spent = this.getSpentForLimit(limit.interval, limit.rail ?? request.rail, scope);
      if (spent + request.amountMist > limit.amount) {
        return { approved: false, reason: `Spending limit exceeded for ${limit.interval}.` };
      }
    }

    return { approved: true };
  }

  private getSpentForLimit(
    interval: 'hour' | 'day' | 'month' | 'lifetime',
    rail?: PaymentRail,
    scope?: string,
  ): bigint {
    const startTime = interval === 'lifetime' ? 0 : getIntervalStart(interval);
    let query = 'SELECT COALESCE(SUM(amount_mist), 0) AS total FROM spending_log WHERE timestamp >= ?';
    const params: Array<bigint | number | string> = [startTime];

    if (rail) {
      query += ' AND rail = ?';
      params.push(rail);
    }

    if (scope) {
      query += ' AND app_id = ?';
      params.push(scope);
    }

    const row = this.db.prepare(query).get(...params) as SpendingLogRow | undefined;
    const total = row?.total ?? 0n;
    return typeof total === 'bigint' ? total : BigInt(total);
  }
}

function getIntervalStart(interval: 'hour' | 'day' | 'month'): number {
  const now = new Date(Date.now());

  if (interval === 'hour') {
    now.setMinutes(0, 0, 0);
    return now.getTime();
  }

  if (interval === 'day') {
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  }

  now.setDate(1);
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}
