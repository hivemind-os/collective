import Database from 'better-sqlite3';

import type { PaymentRail, SpendingPolicy } from '@hivemind-os/collective-types';

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

interface SpendingLogColumn {
  name: string;
}

interface SpendingAmount {
  amount?: bigint;
  amountMist?: bigint;
  currency?: string;
}

export interface SpendingLogEntry {
  id: number;
  amountBaseUnits: bigint;
  rail: PaymentRail;
  currency?: string;
  taskId?: string;
  appId?: string;
  timestamp: number;
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
        amount_base_units INTEGER NOT NULL,
        rail TEXT NOT NULL,
        currency TEXT,
        task_id TEXT,
        app_id TEXT,
        timestamp INTEGER NOT NULL
      );
    `);
    this.migrateSpendingLogSchema();
  }

  evaluate(request: SpendingAmount & { rail: PaymentRail; appId?: string; originAppName?: string }): SpendingPolicyDecision {
    const amount = resolveAmount(request);
    const normalizedCurrency = normalizeCurrency(request.currency);
    const originAppName = request.originAppName;
    const normalizedRequest = {
      amount,
      currency: normalizedCurrency,
      rail: request.rail,
      appId: request.appId,
    };
    const perAppPolicy = originAppName ? this.policy.perApp?.[originAppName] : undefined;
    if (perAppPolicy) {
      const perAppDecision = this.evaluateLimits(perAppPolicy.limits, normalizedRequest, originAppName);
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

    if (this.policy.requireConfirmationAbove !== undefined && amount > this.policy.requireConfirmationAbove) {
      return { approved: false, reason: 'Amount requires confirmation.' };
    }

    return this.evaluateLimits(this.policy.limits, normalizedRequest);
  }

  record(entry: SpendingAmount & { rail: PaymentRail; taskId: string; appId?: string; originAppName?: string }): void {
    const amount = resolveAmount(entry);
    this.db
      .prepare(
        `INSERT INTO spending_log (amount_base_units, rail, currency, task_id, app_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        amount,
        entry.rail,
        normalizeCurrency(entry.currency) ?? null,
        entry.taskId,
        entry.originAppName ?? entry.appId ?? null,
        Date.now(),
      );
  }

  getSpent(interval: 'hour' | 'day' | 'month', rail?: PaymentRail, appId?: string, currency?: string): bigint {
    return this.getSpentForLimit(interval, rail, appId, normalizeCurrency(currency));
  }

  /** Return the most recent spending log entries, newest first. */
  getRecentEntries(limit = 50): SpendingLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, amount_base_units, rail, currency, task_id, app_id, timestamp
         FROM spending_log ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      amount_base_units: bigint;
      rail: string;
      currency: string | null;
      task_id: string | null;
      app_id: string | null;
      timestamp: bigint;
    }>;
    return rows.map((row) => ({
      id: row.id,
      amountBaseUnits: row.amount_base_units,
      rail: row.rail as PaymentRail,
      currency: row.currency ?? undefined,
      taskId: row.task_id ?? undefined,
      appId: row.app_id ?? undefined,
      timestamp: Number(row.timestamp),
    }));
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
      amount: bigint;
      currency?: string;
      rail: PaymentRail;
      appId?: string;
    },
    appScope?: string,
  ): SpendingPolicyDecision {
    for (const limit of limits) {
      if (limit.rail && limit.rail !== request.rail) {
        continue;
      }

      const limitCurrency = normalizeCurrency(limit.currency);
      if (limitCurrency && limitCurrency !== request.currency) {
        continue;
      }

      const scope = appScope ?? limit.scope;
      if (!appScope && limit.scope && limit.scope !== request.appId) {
        continue;
      }

      if (limit.interval === 'transaction' && request.amount > limit.amount) {
        return { approved: false, reason: `Transaction limit exceeded for ${limit.interval}.` };
      }

      if (limit.interval === 'transaction') {
        continue;
      }

      const spent = this.getSpentForLimit(limit.interval, limit.rail ?? request.rail, scope, limitCurrency ?? request.currency);
      if (spent + request.amount > limit.amount) {
        return { approved: false, reason: `Spending limit exceeded for ${limit.interval}.` };
      }
    }

    return { approved: true };
  }

  private getSpentForLimit(
    interval: 'hour' | 'day' | 'month' | 'lifetime',
    rail?: PaymentRail,
    scope?: string,
    currency?: string,
  ): bigint {
    const startTime = interval === 'lifetime' ? 0 : getIntervalStart(interval);
    let query = 'SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM spending_log WHERE timestamp >= ?';
    const params: Array<bigint | number | string> = [startTime];

    if (rail) {
      query += ' AND rail = ?';
      params.push(rail);
    }

    if (scope) {
      query += ' AND app_id = ?';
      params.push(scope);
    }

    if (currency) {
      query += ' AND currency = ?';
      params.push(currency);
    }

    const row = this.db.prepare(query).get(...params) as SpendingLogRow | undefined;
    const total = row?.total ?? 0n;
    return typeof total === 'bigint' ? total : BigInt(total);
  }

  private migrateSpendingLogSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(spending_log)').all() as SpendingLogColumn[];
    const columnNames = new Set(columns.map((column) => column.name));

    if (columnNames.has('amount_mist') && !columnNames.has('amount_base_units')) {
      this.db.exec('ALTER TABLE spending_log RENAME COLUMN amount_mist TO amount_base_units');
    }

    if (!columnNames.has('currency')) {
      this.db.exec('ALTER TABLE spending_log ADD COLUMN currency TEXT');
    }
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

function resolveAmount(value: SpendingAmount): bigint {
  if (value.amount !== undefined && value.amountMist !== undefined && value.amount !== value.amountMist) {
    throw new Error('amount and amountMist must match when both are provided.');
  }

  if (value.amount !== undefined) {
    return value.amount;
  }

  if (value.amountMist !== undefined) {
    return value.amountMist;
  }

  throw new Error('A spending amount is required.');
}

function normalizeCurrency(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim().toUpperCase() : undefined;
}
