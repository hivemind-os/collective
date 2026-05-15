import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface IndexerConfig {
  rpcUrl: string;
  packageId: string;
  sqlitePath: string;
  pollingIntervalMs: number;
  server: {
    host: string;
    port: number;
  };
  backfill: {
    fromCheckpoint?: number;
  };
}

export function getDefaultIndexerConfig(baseDir = resolve(homedir(), '.agentic-mesh', 'indexer')): IndexerConfig {
  return {
    rpcUrl: 'http://127.0.0.1:9000',
    packageId: '',
    sqlitePath: join(baseDir, 'indexer.sqlite'),
    pollingIntervalMs: 5_000,
    server: {
      host: '0.0.0.0',
      port: 4000,
    },
    backfill: {},
  };
}

export function loadIndexerConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  const baseDir = process.env.MESH_INDEXER_DATA_DIR ? resolve(process.env.MESH_INDEXER_DATA_DIR) : undefined;
  const defaults = getDefaultIndexerConfig(baseDir);
  const config: IndexerConfig = {
    rpcUrl: process.env.MESH_RPC_URL ?? process.env.MESH_INDEXER_RPC_URL ?? overrides.rpcUrl ?? defaults.rpcUrl,
    packageId: process.env.MESH_PACKAGE_ID ?? process.env.MESH_INDEXER_PACKAGE_ID ?? overrides.packageId ?? defaults.packageId,
    sqlitePath: resolve(overrides.sqlitePath ?? process.env.MESH_INDEXER_SQLITE_PATH ?? defaults.sqlitePath),
    pollingIntervalMs:
      readNumber(process.env.MESH_INDEXER_POLLING_INTERVAL_MS) ?? overrides.pollingIntervalMs ?? defaults.pollingIntervalMs,
    server: {
      host: overrides.server?.host ?? process.env.MESH_INDEXER_HOST ?? defaults.server.host,
      port: readNumber(process.env.MESH_INDEXER_PORT) ?? overrides.server?.port ?? defaults.server.port,
    },
    backfill:
      overrides.backfill || process.env.MESH_INDEXER_START_CHECKPOINT
        ? {
            fromCheckpoint:
              overrides.backfill?.fromCheckpoint ?? readNumber(process.env.MESH_INDEXER_START_CHECKPOINT),
          }
        : defaults.backfill,
  };

  validateIndexerConfig(config);
  return config;
}

export function validateIndexerConfig(config: IndexerConfig): void {
  if (!config.rpcUrl) {
    throw new Error('Indexer rpcUrl is required.');
  }
  if (!Number.isInteger(config.pollingIntervalMs) || config.pollingIntervalMs <= 0) {
    throw new Error('Indexer polling interval must be a positive integer.');
  }
  if (!config.server.host) {
    throw new Error('Indexer server host is required.');
  }
  if (!Number.isInteger(config.server.port) || config.server.port <= 0) {
    throw new Error('Indexer server port must be a positive integer.');
  }
  if (!config.sqlitePath) {
    throw new Error('Indexer sqlitePath is required.');
  }
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
