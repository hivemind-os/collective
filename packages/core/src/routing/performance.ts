import Database from 'better-sqlite3';

export interface PerformanceTrackerOptions {
  dbPath?: string;
  now?: () => number;
  maxSamplesPerCapability?: number;
}

interface DurationRow {
  duration_ms: bigint | number;
}

interface AggregateRow {
  success_count: bigint | number;
  failure_count: bigint | number;
  last_updated: bigint | number;
}

interface MetricRow {
  provider_did: string;
  capability: string;
  avg_duration_ms: bigint | number;
  p50: bigint | number;
  p95: bigint | number;
  success_count: bigint | number;
  failure_count: bigint | number;
  last_updated: bigint | number;
}

export interface ProviderCapabilityPerformance {
  capability: string;
  avgDurationMs: number;
  p50: number;
  p95: number;
  successCount: number;
  failureCount: number;
  lastUpdated: number;
}

export interface ProviderPerformanceStats {
  providerDid: string;
  avgDurationMs: number;
  p50: number;
  p95: number;
  successCount: number;
  failureCount: number;
  lastUpdated?: number;
  capabilities: ProviderCapabilityPerformance[];
}

export class PerformanceTracker {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly maxSamplesPerCapability: number;

  constructor(options: PerformanceTrackerOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:');
    this.db.defaultSafeIntegers(true);
    this.now = options.now ?? (() => Date.now());
    this.maxSamplesPerCapability = Math.max(10, Math.floor(options.maxSamplesPerCapability ?? 500));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_did TEXT NOT NULL,
        capability TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_metric_samples_lookup
        ON provider_metric_samples(provider_did, capability, recorded_at);
      CREATE TABLE IF NOT EXISTS provider_metrics (
        provider_did TEXT NOT NULL,
        capability TEXT NOT NULL,
        avg_duration_ms INTEGER NOT NULL,
        p50 INTEGER NOT NULL,
        p95 INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        PRIMARY KEY (provider_did, capability)
      );
    `);
  }

  recordCompletion(provider: string, capability: string, durationMs: number, success: boolean): void {
    if (!provider.trim()) {
      throw new Error('provider must be a non-empty string.');
    }
    if (!capability.trim()) {
      throw new Error('capability must be a non-empty string.');
    }
    if (!Number.isFinite(durationMs)) {
      throw new Error('durationMs must be finite.');
    }

    const normalizedDuration = Math.max(0, Math.round(durationMs));
    const recordedAt = this.now();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO provider_metric_samples (provider_did, capability, duration_ms, success, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(provider, capability, normalizedDuration, success ? 1 : 0, recordedAt);
      this.db
        .prepare(
          `DELETE FROM provider_metric_samples
           WHERE id IN (
             SELECT id
             FROM provider_metric_samples
             WHERE provider_did = ? AND capability = ?
             ORDER BY recorded_at DESC, id DESC
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(provider, capability, this.maxSamplesPerCapability);

      const durations = this.db
        .prepare(
          `SELECT duration_ms
           FROM provider_metric_samples
           WHERE provider_did = ? AND capability = ?
           ORDER BY duration_ms ASC, recorded_at ASC`,
        )
        .all(provider, capability) as DurationRow[];
      const aggregate = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS success_count,
             COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failure_count,
             COALESCE(MAX(recorded_at), 0) AS last_updated
           FROM provider_metric_samples
           WHERE provider_did = ? AND capability = ?`,
        )
        .get(provider, capability) as AggregateRow;

      const numericDurations = durations.map((entry) => Number(entry.duration_ms));
      const avgDurationMs = numericDurations.length === 0
        ? 0
        : Math.round(numericDurations.reduce((sum, entry) => sum + entry, 0) / numericDurations.length);
      const p50 = percentile(numericDurations, 0.5);
      const p95 = percentile(numericDurations, 0.95);

      this.db
        .prepare(
          `INSERT INTO provider_metrics (
             provider_did, capability, avg_duration_ms, p50, p95, success_count, failure_count, last_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_did, capability) DO UPDATE SET
             avg_duration_ms = excluded.avg_duration_ms,
             p50 = excluded.p50,
             p95 = excluded.p95,
             success_count = excluded.success_count,
             failure_count = excluded.failure_count,
             last_updated = excluded.last_updated`,
        )
        .run(
          provider,
          capability,
          avgDurationMs,
          p50,
          p95,
          Number(aggregate.success_count),
          Number(aggregate.failure_count),
          Number(aggregate.last_updated),
        );
    });

    transaction();
  }

  getEstimatedLatency(provider: string, capability: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT avg_duration_ms, p50, p95
         FROM provider_metrics
         WHERE provider_did = ? AND capability = ?`,
      )
      .get(provider, capability) as Pick<MetricRow, 'avg_duration_ms' | 'p50' | 'p95'> | undefined;
    if (!row) {
      return undefined;
    }

    return Number(row.p50 ?? row.avg_duration_ms ?? row.p95);
  }

  getProviderStats(provider: string): ProviderPerformanceStats {
    const rows = this.db
      .prepare(
        `SELECT provider_did, capability, avg_duration_ms, p50, p95, success_count, failure_count, last_updated
         FROM provider_metrics
         WHERE provider_did = ?
         ORDER BY capability ASC`,
      )
      .all(provider) as MetricRow[];

    const capabilities = rows.map((row) => ({
      capability: row.capability,
      avgDurationMs: Number(row.avg_duration_ms),
      p50: Number(row.p50),
      p95: Number(row.p95),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      lastUpdated: Number(row.last_updated),
    }));

    if (capabilities.length === 0) {
      return {
        providerDid: provider,
        avgDurationMs: 0,
        p50: 0,
        p95: 0,
        successCount: 0,
        failureCount: 0,
        capabilities: [],
      };
    }

    return {
      providerDid: provider,
      avgDurationMs: Math.round(capabilities.reduce((sum, entry) => sum + entry.avgDurationMs, 0) / capabilities.length),
      p50: Math.round(capabilities.reduce((sum, entry) => sum + entry.p50, 0) / capabilities.length),
      p95: Math.round(capabilities.reduce((sum, entry) => sum + entry.p95, 0) / capabilities.length),
      successCount: capabilities.reduce((sum, entry) => sum + entry.successCount, 0),
      failureCount: capabilities.reduce((sum, entry) => sum + entry.failureCount, 0),
      lastUpdated: Math.max(...capabilities.map((entry) => entry.lastUpdated)),
      capabilities,
    };
  }

  close(): void {
    this.db.close();
  }
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileRank) - 1));
  return values[index] ?? 0;
}
