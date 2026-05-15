import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { PaymentRail, type NetworkConfig, type SpendingPolicy } from '@agentic-mesh/types';
import yaml from 'js-yaml';

import { success } from '../utils/output.js';

export interface MeshCliConfig {
  network: NetworkConfig;
  identity: {
    dataDir: string;
  };
  spending: SpendingPolicy;
  daemon: {
    ipcPath: string;
    dataDir: string;
    pidFile: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
  blobstore: {
    type: 'filesystem';
    baseDir: string;
  };
}

type LooseRecord = Record<string, unknown>;
const LOG_LEVELS = new Set<MeshCliConfig['daemon']['logLevel']>(['debug', 'info', 'warn', 'error']);

export async function handleConfig(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.log(yaml.dump(redactConfig(serializeConfig(loadMeshConfig())), { lineWidth: 120 }));
    return 0;
  }

  if (subcommand === 'path') {
    console.log(getConfigPath());
    return 0;
  }

  if (subcommand === 'set') {
    const key = rest[0];
    const rawValue = rest.slice(1).join(' ');
    if (!key || !rawValue) {
      throw new Error('Usage: mesh config set <key> <value>');
    }

    const config = loadMeshConfig();
    setNestedValue(config as unknown as LooseRecord, key, parseConfigValue(rawValue));
    saveMeshConfig(config);
    success(`Updated ${key}`);
    return 0;
  }

  throw new Error('Usage: mesh config [path|set <key> <value>]');
}

export function getMeshDataDir(): string {
  return normalizePath(process.env.MESH_DATA_DIR ?? join(homedir(), '.agentic-mesh'));
}

export function getConfigPath(configPath?: string): string {
  return normalizePath(configPath ?? join(getMeshDataDir(), 'config.yaml'));
}

export function buildDefaultConfig(dataDir = getMeshDataDir()): MeshCliConfig {
  const resolvedDataDir = normalizePath(dataDir);
  return {
    network: {
      rpcUrl: process.env.MESH_RPC_URL ?? 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: process.env.MESH_PACKAGE_ID ?? '',
      registryId: process.env.MESH_REGISTRY_ID ?? '',
    },
    identity: {
      dataDir: join(resolvedDataDir, 'identity'),
    },
    spending: {
      defaultRail: PaymentRail.SUI_ESCROW,
      limits: [{ amount: 1_000_000_000n, interval: 'day' }],
    },
    daemon: {
      ipcPath: process.platform === 'win32' ? '\\\\.\\pipe\\agentic-mesh' : join(resolvedDataDir, 'mesh.sock'),
      dataDir: resolvedDataDir,
      pidFile: join(resolvedDataDir, 'daemon.pid'),
      logLevel: normalizeLogLevel(process.env.MESH_LOG_LEVEL, 'info'),
      logFile: join(resolvedDataDir, 'daemon.log'),
    },
    blobstore: {
      type: 'filesystem',
      baseDir: join(resolvedDataDir, 'blobs'),
    },
  };
}

export function loadMeshConfig(configPath?: string): MeshCliConfig {
  const resolvedConfigPath = getConfigPath(configPath);
  const parsed = loadConfigFile(resolvedConfigPath);
  const baseDataDir = normalizePath(
    process.env.MESH_DATA_DIR ?? readString(getNestedValue(parsed, 'daemon', 'dataDir')) ?? dirname(resolvedConfigPath),
  );
  const defaults = buildDefaultConfig(baseDataDir);
  const config = applyEnvironmentOverrides(mergeConfig(defaults, parsed));
  validateConfig(config);

  if (!existsSync(resolvedConfigPath)) {
    saveMeshConfig(config, resolvedConfigPath);
  } else {
    enforcePrivateFilePermissions(resolvedConfigPath);
  }

  return config;
}

export function saveMeshConfig(config: MeshCliConfig, configPath = getConfigPath()): string {
  const resolvedConfigPath = getConfigPath(configPath);
  mkdirSync(dirname(resolvedConfigPath), { recursive: true, mode: 0o700 });
  writePrivateConfigFile(resolvedConfigPath, yaml.dump(serializeConfig(config), { lineWidth: 120 }));
  return resolvedConfigPath;
}

function writePrivateConfigFile(configPath: string, contents: string): void {
  writeFileSync(configPath, contents, { encoding: 'utf8', mode: 0o600 });
  enforcePrivateFilePermissions(configPath);
}

function enforcePrivateFilePermissions(path: string): void {
  chmodSync(path, 0o600);
}

export function serializeConfig(config: MeshCliConfig): LooseRecord {
  return serializeValue(config) as LooseRecord;
}

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfig(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as LooseRecord).map(([key, entry]) => [
        key,
        /(secret|token|password|private)/i.test(key) ? '<redacted>' : redactConfig(entry),
      ]),
    );
  }

  return value;
}

function loadConfigFile(configPath: string): LooseRecord {
  if (!existsSync(configPath)) {
    return {};
  }

  const loaded = yaml.load(readFileSync(configPath, 'utf8'));
  return isRecord(loaded) ? loaded : {};
}

function mergeConfig(defaults: MeshCliConfig, parsed: LooseRecord): MeshCliConfig {
  const network = isRecord(parsed.network) ? parsed.network : {};
  const identity = isRecord(parsed.identity) ? parsed.identity : {};
  const daemon = isRecord(parsed.daemon) ? parsed.daemon : {};
  const blobstore = isRecord(parsed.blobstore) ? parsed.blobstore : {};

  return {
    network: {
      rpcUrl: readString(network.rpcUrl) ?? defaults.network.rpcUrl,
      faucetUrl: readString(network.faucetUrl) ?? defaults.network.faucetUrl,
      packageId: readHexString(network.packageId) ?? defaults.network.packageId,
      registryId: readHexString(network.registryId) ?? defaults.network.registryId,
    },
    identity: {
      dataDir: normalizePath(readString(identity.dataDir) ?? defaults.identity.dataDir),
    },
    spending: normalizeSpendingPolicy(parsed.spending, defaults.spending),
    daemon: {
      ipcPath: readString(daemon.ipcPath) ?? defaults.daemon.ipcPath,
      dataDir: normalizePath(readString(daemon.dataDir) ?? defaults.daemon.dataDir),
      pidFile: normalizePath(readString(daemon.pidFile) ?? defaults.daemon.pidFile),
      logLevel: normalizeLogLevel(daemon.logLevel, defaults.daemon.logLevel),
      logFile: readString(daemon.logFile) ? normalizePath(readString(daemon.logFile) as string) : defaults.daemon.logFile,
    },
    blobstore: {
      type: 'filesystem',
      baseDir: normalizePath(readString(blobstore.baseDir) ?? defaults.blobstore.baseDir),
    },
  };
}

function applyEnvironmentOverrides(config: MeshCliConfig): MeshCliConfig {
  const envDataDir = process.env.MESH_DATA_DIR ? normalizePath(process.env.MESH_DATA_DIR) : undefined;
  const withDataDir = envDataDir
    ? {
        ...config,
        identity: { dataDir: join(envDataDir, 'identity') },
        daemon: {
          ...config.daemon,
          dataDir: envDataDir,
          pidFile: join(envDataDir, 'daemon.pid'),
          ipcPath: process.platform === 'win32' ? '\\\\.\\pipe\\agentic-mesh' : join(envDataDir, 'mesh.sock'),
          logFile: join(envDataDir, 'daemon.log'),
        },
        blobstore: {
          type: 'filesystem' as const,
          baseDir: join(envDataDir, 'blobs'),
        },
      }
    : config;

  return {
    ...withDataDir,
    network: {
      ...withDataDir.network,
      rpcUrl: process.env.MESH_RPC_URL ?? withDataDir.network.rpcUrl,
      packageId: process.env.MESH_PACKAGE_ID ?? withDataDir.network.packageId,
      registryId: process.env.MESH_REGISTRY_ID ?? withDataDir.network.registryId,
    },
    daemon: {
      ...withDataDir.daemon,
      logLevel: normalizeLogLevel(process.env.MESH_LOG_LEVEL, withDataDir.daemon.logLevel),
    },
  };
}

function normalizeSpendingPolicy(value: unknown, defaults: SpendingPolicy): SpendingPolicy {
  if (!isRecord(value)) {
    return defaults;
  }

  return {
    defaultRail: normalizeRail(value.defaultRail) ?? defaults.defaultRail,
    requireConfirmationAbove:
      value.requireConfirmationAbove === undefined
        ? defaults.requireConfirmationAbove
        : parseBigInt(value.requireConfirmationAbove, 'spending.requireConfirmationAbove'),
    allowlist: Array.isArray(value.allowlist)
      ? value.allowlist.filter((entry): entry is string => typeof entry === 'string')
      : defaults.allowlist,
    denylist: Array.isArray(value.denylist)
      ? value.denylist.filter((entry): entry is string => typeof entry === 'string')
      : defaults.denylist,
    limits:
      Array.isArray(value.limits) && value.limits.length > 0
        ? value.limits.map((limit, index) => normalizeSpendingLimit(limit, index))
        : defaults.limits,
  };
}

function normalizeSpendingLimit(value: unknown, index: number): SpendingPolicy['limits'][number] {
  if (!isRecord(value)) {
    throw new Error(`spending.limits[${index}] must be an object.`);
  }

  const interval = readString(value.interval);
  if (!interval || !['transaction', 'hour', 'day', 'month', 'lifetime'].includes(interval)) {
    throw new Error(`spending.limits[${index}].interval is invalid.`);
  }

  return {
    amount: parseBigInt(value.amount, `spending.limits[${index}].amount`),
    interval,
    rail: normalizeRail(value.rail),
    scope: readString(value.scope) ?? undefined,
  };
}

function validateConfig(config: MeshCliConfig): void {
  if (!config.network.rpcUrl) {
    throw new Error('network.rpcUrl is required.');
  }

  if (!config.identity.dataDir) {
    throw new Error('identity.dataDir is required.');
  }

  if (!config.daemon.ipcPath || !config.daemon.dataDir || !config.daemon.pidFile) {
    throw new Error('daemon configuration is incomplete.');
  }

  if (!LOG_LEVELS.has(config.daemon.logLevel)) {
    throw new Error(`Invalid log level: ${config.daemon.logLevel}`);
  }

  if (!config.blobstore.baseDir) {
    throw new Error('blobstore.baseDir is required.');
  }
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as LooseRecord).map(([key, entry]) => [key, serializeValue(entry)]));
  }

  return value;
}

function normalizeLogLevel(value: unknown, fallback: MeshCliConfig['daemon']['logLevel']): MeshCliConfig['daemon']['logLevel'] {
  return typeof value === 'string' && LOG_LEVELS.has(value as MeshCliConfig['daemon']['logLevel'])
    ? (value as MeshCliConfig['daemon']['logLevel'])
    : fallback;
}

function normalizeRail(value: unknown): PaymentRail | undefined {
  if (value === PaymentRail.SUI_ESCROW || value === PaymentRail.X402_BASE) {
    return value;
  }

  return undefined;
}

function parseBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  throw new Error(`${field} must be a non-negative integer.`);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readHexString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}`;
  }

  return undefined;
}

function normalizePath(value: string): string {
  return resolve(expandHome(value));
}

function expandHome(value: string): string {
  if (value === '~') {
    return homedir();
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }

  return value;
}

function getNestedValue(record: LooseRecord, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function parseConfigValue(rawValue: string): unknown {
  const parsed = yaml.load(rawValue);
  return parsed === undefined ? rawValue : parsed;
}

function setNestedValue(target: LooseRecord, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.').filter(Boolean);
  if (keys.length === 0) {
    throw new Error('Config key is required.');
  }

  let current: LooseRecord = target;
  for (const key of keys.slice(0, -1)) {
    const existing = current[key];
    if (!isRecord(existing)) {
      current[key] = {};
    }
    current = current[key] as LooseRecord;
  }

  current[keys[keys.length - 1] as string] = value;
}

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
