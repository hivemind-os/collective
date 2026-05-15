import Database from 'better-sqlite3';

import type { StreamingPaymentState } from '@agentic-mesh/types';

interface StreamRow {
  task_id: string;
  total_paid: bigint | number | string;
  max_budget: bigint | number | string;
  unit_price: bigint | number | string;
  current_unit: number | bigint;
  last_payment_timestamp: number | bigint;
}

interface PaymentRow {
  task_id: string;
  unit_index: number | bigint;
  amount: bigint | number | string;
  timestamp: number | bigint;
}

export interface StreamingPaymentManagerOptions {
  dbPath: string;
  now?: () => number;
  paymentProcessor?: (entry: {
    taskId: string;
    amount: bigint;
    unitIndex: number;
    totalPaid: bigint;
    timestamp: number;
  }) => Promise<void> | void;
}

export class StreamingPaymentManager {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(private readonly options: StreamingPaymentManagerOptions) {
    this.db = new Database(options.dbPath);
    this.db.defaultSafeIntegers(true);
    this.now = options.now ?? (() => Date.now());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streaming_payment_state (
        task_id TEXT PRIMARY KEY,
        total_paid TEXT NOT NULL,
        max_budget TEXT NOT NULL,
        unit_price TEXT NOT NULL,
        current_unit INTEGER NOT NULL,
        last_payment_timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS streaming_payment_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        unit_index INTEGER NOT NULL,
        amount TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  startStream(taskId: string, maxBudget: bigint, unitPrice: bigint): StreamingPaymentState {
    taskId = normalizeTaskId(taskId);
    if (maxBudget < 0n) {
      throw new Error('maxBudget must be non-negative.');
    }
    if (unitPrice <= 0n) {
      throw new Error('unitPrice must be positive.');
    }

    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO streaming_payment_state (
          task_id, total_paid, max_budget, unit_price, current_unit, last_payment_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, '0', maxBudget.toString(), unitPrice.toString(), 0, timestamp);

    return {
      taskId,
      totalPaid: 0n,
      maxBudget,
      currentUnit: 0,
      lastPaymentTimestamp: timestamp,
    };
  }

  getState(taskId: string): StreamingPaymentState | null {
    const row = this.db.prepare('SELECT * FROM streaming_payment_state WHERE task_id = ?').get(normalizeTaskId(taskId)) as StreamRow | undefined;
    return row ? mapStreamRow(row) : null;
  }

  async payUnit(taskId: string): Promise<StreamingPaymentState> {
    taskId = normalizeTaskId(taskId);
    const row = this.requireStreamRow(taskId);
    const state = mapStreamRow(row);
    const unitPrice = toBigInt(row.unit_price);
    const remainingBudget = state.maxBudget - state.totalPaid;
    const amount = remainingBudget < unitPrice ? remainingBudget : unitPrice;
    if (amount <= 0n) {
      return state;
    }

    const nextState: StreamingPaymentState = {
      taskId: state.taskId,
      totalPaid: state.totalPaid + amount,
      maxBudget: state.maxBudget,
      currentUnit: state.currentUnit + 1,
      lastPaymentTimestamp: this.now(),
    };

    // v1 streaming uses periodic on-chain transfers recorded locally; it is not a payment channel.
    await this.options.paymentProcessor?.({
      taskId,
      amount,
      unitIndex: nextState.currentUnit,
      totalPaid: nextState.totalPaid,
      timestamp: nextState.lastPaymentTimestamp,
    });

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE streaming_payment_state
           SET total_paid = ?, current_unit = ?, last_payment_timestamp = ?
           WHERE task_id = ?`,
        )
        .run(nextState.totalPaid.toString(), nextState.currentUnit, nextState.lastPaymentTimestamp, taskId);
      this.db
        .prepare(
          `INSERT INTO streaming_payment_log (task_id, unit_index, amount, timestamp)
           VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, nextState.currentUnit, amount.toString(), nextState.lastPaymentTimestamp);
    })();

    return nextState;
  }

  finalizeStream(taskId: string): { state: StreamingPaymentState; refundAmount: bigint } {
    const state = this.getState(normalizeTaskId(taskId));
    if (!state) {
      throw new Error(`Unknown stream for task ${taskId}.`);
    }

    return {
      state,
      refundAmount: state.maxBudget - state.totalPaid,
    };
  }

  getAuditTrail(taskId: string): Array<{ taskId: string; unitIndex: number; amount: bigint; timestamp: number }> {
    const rows = this.db
      .prepare('SELECT task_id, unit_index, amount, timestamp FROM streaming_payment_log WHERE task_id = ? ORDER BY id ASC')
      .all(normalizeTaskId(taskId)) as PaymentRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      unitIndex: Number(row.unit_index),
      amount: toBigInt(row.amount),
      timestamp: Number(row.timestamp),
    }));
  }

  close(): void {
    this.db.close();
  }

  private requireStreamRow(taskId: string): StreamRow {
    const row = this.db.prepare('SELECT * FROM streaming_payment_state WHERE task_id = ?').get(normalizeTaskId(taskId)) as StreamRow | undefined;
    if (!row) {
      throw new Error(`Unknown stream for task ${taskId}.`);
    }
    return row;
  }
}

function normalizeTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) {
    throw new Error('taskId is required.');
  }
  return normalized;
}

function mapStreamRow(row: StreamRow): StreamingPaymentState {
  return {
    taskId: row.task_id,
    totalPaid: toBigInt(row.total_paid),
    maxBudget: toBigInt(row.max_budget),
    currentUnit: Number(row.current_unit),
    lastPaymentTimestamp: Number(row.last_payment_timestamp),
  };
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
