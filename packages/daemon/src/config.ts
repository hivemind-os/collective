import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  PaymentRail,
  type AuthConfig,
  type BlobStoreConfig,
  type NetworkConfig,
  type SpendingLimit,
  type SpendingPolicy,
} from '@agentic-mesh/types';
import yaml from 'js-yaml';

export interface DaemonPerAppSpendingConfig {
  limits: SpendingLimit[];
}

export interface DaemonSpendingPolicy extends SpendingPolicy {
  perApp?: Record<string, DaemonPerAppSpendingConfig>;
}

export interface DaemonFullConfig {
  network: NetworkConfig;
  identity: {
    dataDir: string;
  };
  auth: AuthConfig;
  spending: DaemonSpendingPolicy;
  daemon: {
    ipcPath: string;
    dataDir: string;
    pidFile: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
  blobstore: BlobStoreConfig;
  provider?: {
    enabled: boolean;
    capabilities: Array<{
      name: string;
      description: string;
      version: string;
      priceMist: number;
      currency?: string;
      adapter: string;
    }>;
    maxConcurrency?: number;
    autoRegister?: boolean;
  };
}

type LooseRecord = Record<string, unknown>;
const LOG_LEVELS = new Set<DaemonFullConfig['daemon']['logLevel']>(['debug', 'info', 'warn', 'error']);

export function getDefaultConfig(): DaemonFullConfig {
  return buildDefaultConfig(resolve(homedir(), '.agentic-mesh'));
}

export function loadConfig(configPath?: string): DaemonFullConfig {
  const resolvedConfigPath = resolve(
    expandHome(configPath ?? join(getEnvDataDir() ?? resolve(homedir(), '.agentic-mesh'), 'config.yaml')),
  );

  const parsed = loadConfigFile(resolvedConfigPath);
  const baseDataDir = normalizePath(
    getEnvDataDir() ?? readString(getNestedValue(parsed, 'daemon', 'dataDir')) ?? resolve(homedir(), '.agentic-mesh'),
  );

  let config = mergeConfig(buildDefaultConfig(baseDataDir), parsed);
  config = applyEnvironmentOverrides(config);
  validateConfig(config);

  if (!existsSync(resolvedConfigPath)) {
    mkdirSync(dirname(resolvedConfigPath), { recursive: true, mode: 0o700 });
    writePrivateConfigFile(resolvedConfigPath, yaml.dump(serializeConfig(config)));
  } else {
    enforcePrivateFilePermissions(resolvedConfigPath);
  }

  return config;
}

function writePrivateConfigFile(configPath: string, contents: string): void {
  writeFileSync(configPath, contents, { encoding: 'utf8', mode: 0o600 });
  enforcePrivateFilePermissions(configPath);
}

function enforcePrivateFilePermissions(path: string): void {
  chmodSync(path, 0o600);
}

function loadConfigFile(configPath: string): LooseRecord {
  if (!existsSync(configPath)) {
    return {};
  }

  const loaded = yaml.load(readFileSync(configPath, 'utf8'));
  return isRecord(loaded) ? loaded : {};
}

function buildDefaultConfig(dataDir: string): DaemonFullConfig {
  const resolvedDataDir = normalizePath(dataDir);

  return {
    network: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '',
      registryId: '',
    },
    identity: {
      dataDir: join(resolvedDataDir, 'identity'),
    },
    auth: {
      mode: 'ed25519',
      portal: {
        port: 19876,
      },
    },
    spending: {
      defaultRail: PaymentRail.SUI_ESCROW,
      limits: [{ amount: 1_000_000_000n, interval: 'day' }],
    },
    daemon: {
      ipcPath:
        process.platform === 'win32' ? '\\\\.\\pipe\\agentic-mesh' : join(resolvedDataDir, 'mesh.sock'),
      dataDir: resolvedDataDir,
      pidFile: join(resolvedDataDir, 'daemon.pid'),
      logLevel: 'info',
    },
    blobstore: {
      mode: 'filesystem',
      filesystem: {
        dataDir: join(resolvedDataDir, 'blobs'),
      },
    },
  };
}

function mergeConfig(defaults: DaemonFullConfig, parsed: LooseRecord): DaemonFullConfig {
  const network = isRecord(parsed.network) ? parsed.network : {};
  const identity = isRecord(parsed.identity) ? parsed.identity : {};
  const auth = isRecord(parsed.auth) ? parsed.auth : {};
  const daemon = isRecord(parsed.daemon) ? parsed.daemon : {};
  const blobstore = isRecord(parsed.blobstore) ? parsed.blobstore : {};
  const provider = isRecord(parsed.provider) ? parsed.provider : undefined;

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
    auth: normalizeAuthConfig(auth, defaults.auth),
    spending: normalizeSpendingPolicy(parsed.spending, defaults.spending),
    daemon: {
      ipcPath: readString(daemon.ipcPath) ?? defaults.daemon.ipcPath,
      dataDir: normalizePath(readString(daemon.dataDir) ?? defaults.daemon.dataDir),
      pidFile: normalizePath(readString(daemon.pidFile) ?? defaults.daemon.pidFile),
      logLevel: normalizeLogLevel(daemon.logLevel, defaults.daemon.logLevel),
      logFile: readString(daemon.logFile) ? normalizePath(readString(daemon.logFile) as string) : undefined,
    },
    blobstore: normalizeBlobStoreConfig(blobstore, defaults.blobstore),
    provider: normalizeProviderConfig(provider),
  };
}

function applyEnvironmentOverrides(config: DaemonFullConfig): DaemonFullConfig {
  const envDataDir = getEnvDataDir();
  const withDataDir = envDataDir
    ? {
        ...config,
        identity: { dataDir: join(envDataDir, 'identity') },
        daemon: {
          ...config.daemon,
          dataDir: envDataDir,
          pidFile: join(envDataDir, 'daemon.pid'),
          ipcPath: process.platform === 'win32' ? '\\\\.\\pipe\\agentic-mesh' : join(envDataDir, 'mesh.sock'),
        },
        blobstore: applyBlobStoreDataDirOverride(config.blobstore, join(envDataDir, 'blobs')),
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

function normalizeAuthConfig(value: LooseRecord, defaults: AuthConfig): AuthConfig {
  const google = isRecord(value.google) ? value.google : {};
  const apple = isRecord(value.apple) ? value.apple : {};
  const portal = isRecord(value.portal) ? value.portal : {};

  return {
    mode: value.mode === 'zklogin' ? 'zklogin' : defaults.mode,
    google: readString(google.clientId)
      ? {
          clientId: readString(google.clientId) as string,
        }
      : defaults.google,
    apple: readString(apple.clientId)
      ? {
          clientId: readString(apple.clientId) as string,
        }
      : defaults.apple,
    portal: {
      port: readPositiveInteger(portal.port, 'auth.portal.port') ?? defaults.portal?.port ?? 19876,
    },
  };
}

function normalizeBlobStoreConfig(value: unknown, defaults: BlobStoreConfig): BlobStoreConfig {
  const blobstore = isRecord(value) ? value : {};
  const filesystem = isRecord(blobstore.filesystem) ? blobstore.filesystem : {};
  const walrus = isRecord(blobstore.walrus) ? blobstore.walrus : {};
  const hybrid = isRecord(blobstore.hybrid) ? blobstore.hybrid : {};
  const mode = normalizeBlobStoreMode(readString(blobstore.mode) ?? readString(blobstore.type) ?? defaults.mode);
  const filesystemDataDir = readString(filesystem.dataDir) ?? readString(blobstore.baseDir) ?? defaults.filesystem?.dataDir;
  const publisherUrl = readString(walrus.publisherUrl) ?? readString(blobstore.publisherUrl) ?? defaults.walrus?.publisherUrl;
  const aggregatorUrl = readString(walrus.aggregatorUrl) ?? readString(blobstore.aggregatorUrl) ?? defaults.walrus?.aggregatorUrl;

  return {
    mode,
    filesystem: filesystemDataDir
      ? {
          dataDir: normalizePath(filesystemDataDir),
        }
      : defaults.filesystem,
    walrus:
      publisherUrl || aggregatorUrl || defaults.walrus
        ? {
            publisherUrl: publisherUrl ?? '',
            aggregatorUrl: aggregatorUrl ?? '',
            epochs: readPositiveInteger(walrus.epochs, 'blobstore.walrus.epochs') ?? defaults.walrus?.epochs,
            maxBlobSize:
              readPositiveInteger(walrus.maxBlobSize, 'blobstore.walrus.maxBlobSize') ?? defaults.walrus?.maxBlobSize,
            retryAttempts:
              readPositiveInteger(walrus.retryAttempts, 'blobstore.walrus.retryAttempts') ?? defaults.walrus?.retryAttempts,
            retryDelayMs:
              readPositiveInteger(walrus.retryDelayMs, 'blobstore.walrus.retryDelayMs') ?? defaults.walrus?.retryDelayMs,
            timeoutMs: readPositiveInteger(walrus.timeoutMs, 'blobstore.walrus.timeoutMs') ?? defaults.walrus?.timeoutMs,
          }
        : defaults.walrus,
    hybrid: {
      cacheLocally: readBoolean(hybrid.cacheLocally) ?? defaults.hybrid?.cacheLocally ?? true,
      preferWalrus: readBoolean(hybrid.preferWalrus) ?? defaults.hybrid?.preferWalrus ?? true,
    },
  };
}

function applyBlobStoreDataDirOverride(config: BlobStoreConfig, dataDir: string): BlobStoreConfig {
  if (config.mode !== 'filesystem' && config.mode !== 'hybrid') {
    return config;
  }

  return {
    ...config,
    filesystem: {
      dataDir,
    },
  };
}

function normalizeBlobStoreMode(value: string): BlobStoreConfig['mode'] {
  if (value === 'filesystem' || value === 'walrus' || value === 'hybrid') {
    return value;
  }

  throw new Error(`Unsupported blobstore mode: ${value}`);
}

function normalizeSpendingPolicy(value: unknown, defaults: DaemonSpendingPolicy): DaemonSpendingPolicy {
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
        ? value.limits.map((limit, index) => normalizeSpendingLimit(limit, index, 'spending.limits'))
        : defaults.limits,
    perApp: normalizePerAppSpendingConfig(value.perApp, defaults.perApp),
  };
}

function normalizePerAppSpendingConfig(
  value: unknown,
  defaults: DaemonSpendingPolicy['perApp'],
): DaemonSpendingPolicy['perApp'] {
  if (!isRecord(value)) {
    return defaults;
  }

  const perApp = Object.entries(value).map(([appName, config]) => {
    if (!isRecord(config)) {
      throw new Error(`spending.perApp.${appName} must be an object.`);
    }

    if (!Array.isArray(config.limits) || config.limits.length === 0) {
      throw new Error(`spending.perApp.${appName}.limits must contain at least one limit.`);
    }

    return [
      appName,
      {
        limits: config.limits.map((limit, index) =>
          normalizeSpendingLimit(limit, index, `spending.perApp.${appName}.limits`),
        ),
      },
    ] as const;
  });

  return Object.fromEntries(perApp);
}

function normalizeSpendingLimit(
  value: unknown,
  index: number,
  path: string,
): DaemonSpendingPolicy['limits'][number] {
  if (!isRecord(value)) {
    throw new Error(`${path}[${index}] must be an object.`);
  }

  const interval = readString(value.interval);
  if (!interval || !['transaction', 'hour', 'day', 'month', 'lifetime'].includes(interval)) {
    throw new Error(`${path}[${index}].interval is invalid.`);
  }

  const normalizedInterval = interval as DaemonSpendingPolicy['limits'][number]['interval'];

  return {
    amount: parseBigInt(value.amount, `${path}[${index}].amount`),
    interval: normalizedInterval,
    rail: normalizeRail(value.rail),
    scope: readString(value.scope) ?? undefined,
  };
}

function normalizeProviderConfig(value: LooseRecord | undefined): DaemonFullConfig['provider'] {
  if (!value) {
    return undefined;
  }

  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.map((entry, index) => normalizeProviderCapability(entry, index))
    : [];

  return {
    enabled: readBoolean(value.enabled) ?? false,
    capabilities,
    maxConcurrency: readPositiveInteger(value.maxConcurrency, 'provider.maxConcurrency'),
    autoRegister: readBoolean(value.autoRegister),
  };
}

function normalizeProviderCapability(
  value: unknown,
  index: number,
): NonNullable<DaemonFullConfig['provider']>['capabilities'][number] {
  if (!isRecord(value)) {
    throw new Error(`provider.capabilities[${index}] must be an object.`);
  }

  const name = readString(value.name);
  const description = readString(value.description);
  const version = readString(value.version);
  const adapter = readString(value.adapter);
  const priceMist = readPositiveInteger(value.priceMist, `provider.capabilities[${index}].priceMist`);

  if (!name || !description || !version || !adapter || priceMist === undefined) {
    throw new Error(`provider.capabilities[${index}] is incomplete.`);
  }

  return {
    name,
    description,
    version,
    priceMist,
    currency: readString(value.currency),
    adapter,
  };
}

function validateConfig(config: DaemonFullConfig): void {
  if (!config.network.rpcUrl) {
    throw new Error('network.rpcUrl is required.');
  }

  if (!config.identity.dataDir) {
    throw new Error('identity.dataDir is required.');
  }

  if (!config.auth.mode) {
    throw new Error('auth.mode is required.');
  }

  if (config.auth.mode === 'zklogin' && !config.auth.google?.clientId) {
    throw new Error('auth.google.clientId is required when auth.mode is zklogin.');
  }

  if (!config.daemon.ipcPath || !config.daemon.dataDir || !config.daemon.pidFile) {
    throw new Error('daemon configuration is incomplete.');
  }

  if (config.blobstore.mode === 'filesystem' || config.blobstore.mode === 'hybrid') {
    if (!config.blobstore.filesystem?.dataDir) {
      throw new Error('blobstore.filesystem.dataDir is required.');
    }
  }

  if (config.blobstore.mode === 'walrus' || config.blobstore.mode === 'hybrid') {
    if (!config.blobstore.walrus?.publisherUrl || !config.blobstore.walrus.aggregatorUrl) {
      throw new Error('blobstore.walrus.publisherUrl and blobstore.walrus.aggregatorUrl are required.');
    }
  }

  if (!LOG_LEVELS.has(config.daemon.logLevel)) {
    throw new Error(`Invalid log level: ${config.daemon.logLevel}`);
  }
}

function serializeConfig(config: DaemonFullConfig): LooseRecord {
  return {
    ...config,
    auth: config.auth,
    spending: {
      ...config.spending,
      requireConfirmationAbove: config.spending.requireConfirmationAbove?.toString(),
      limits: config.spending.limits.map(serializeSpendingLimit),
      perApp: config.spending.perApp
        ? Object.fromEntries(
            Object.entries(config.spending.perApp).map(([appName, appConfig]) => [
              appName,
              {
                limits: appConfig.limits.map(serializeSpendingLimit),
              },
            ]),
          )
        : undefined,
    },
  };
}

function serializeSpendingLimit(limit: DaemonSpendingPolicy['limits'][number]): LooseRecord {
  return {
    ...limit,
    amount: limit.amount.toString(),
  };
}

function normalizeLogLevel(value: unknown, fallback: DaemonFullConfig['daemon']['logLevel']) {
  return typeof value === 'string' && LOG_LEVELS.has(value as DaemonFullConfig['daemon']['logLevel'])
    ? (value as DaemonFullConfig['daemon']['logLevel'])
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

function getEnvDataDir(): string | undefined {
  return process.env.MESH_DATA_DIR ? normalizePath(process.env.MESH_DATA_DIR) : undefined;
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  throw new Error(`${field} must be a non-negative integer.`);
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

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
