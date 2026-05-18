import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  PaymentRail,
  NETWORK_PRESETS,
  getNetworkPreset,
  type AuthConfig,
  type BlobStoreConfig,
  type EncryptionConfig,
  type NetworkConfig,
  type NetworkName,
  type PaymentConfig,
  type SpendingLimit,
  type SpendingPolicy,
} from '@hivemind-os/collective-types';
import yaml from 'js-yaml';

import { getDefaultIpcPath } from './ipc/pipe-security.js';

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
  payment: PaymentConfig;
  daemon: {
    ipcPath: string;
    dataDir: string;
    pidFile: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
  relay: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      relayDid?: string;
    }>;
    autoConnect: boolean;
    providerMode: boolean;
    reconnectIntervalMs?: number;
    heartbeatIntervalMs?: number;
  };
  blobstore: BlobStoreConfig;
  encryption: EncryptionConfig;
  provider?: {
    enabled: boolean;
    capabilities: Array<{
      name: string;
      description: string;
      version: string;
      priceMist: number;
      currency?: string;
      adapter: string;
      adapterConfig?: Record<string, unknown>;
    }>;
    maxConcurrency?: number;
    autoRegister?: boolean;
  };
}

type LooseRecord = Record<string, unknown>;
interface ConfigDiff {
  path: string[];
  value?: unknown;
  delete?: true;
}

const LOG_LEVELS = new Set<DaemonFullConfig['daemon']['logLevel']>(['debug', 'info', 'warn', 'error']);
const configSaveLocks = new Map<string, Promise<void>>();
export const configIo = {
  mkdir: fsPromises.mkdir,
  writeFile: fsPromises.writeFile,
  rename: fsPromises.rename,
  rm: fsPromises.rm,
};

export function getDefaultConfig(): DaemonFullConfig {
  return buildDefaultConfig(resolve(homedir(), '.hivemind-os/collective'));
}

export function getConfigPath(configPath?: string): string {
  return resolve(expandHome(configPath ?? join(getEnvDataDir() ?? resolve(homedir(), '.hivemind-os/collective'), 'config.yaml')));
}

export { getDefaultIpcPath };

export function loadConfig(configPath?: string): DaemonFullConfig {
  const resolvedConfigPath = getConfigPath(configPath);

  const parsed = loadConfigFile(resolvedConfigPath);
  const config = buildResolvedConfig(parsed);
  validateConfig(config);

  if (!fs.existsSync(resolvedConfigPath)) {
    fs.mkdirSync(dirname(resolvedConfigPath), { recursive: true, mode: 0o700 });
    writePrivateConfigFile(resolvedConfigPath, formatConfigContents(serializeConfig(config), resolvedConfigPath));
  } else {
    enforcePrivateFilePermissions(resolvedConfigPath);
  }

  return config;
}

export async function saveConfig(config: DaemonFullConfig, configPath = getConfigPath()): Promise<string> {
  const resolvedConfigPath = getConfigPath(configPath);
  validateConfig(config);

  await withConfigSaveLock(resolvedConfigPath, async () => {
    const parsed = loadConfigFile(resolvedConfigPath);
    const currentConfig = buildResolvedConfig(parsed);
    const updates = collectConfigDiffs(serializeConfig(currentConfig), serializeConfig(config));
    const nextParsed = applyConfigDiffs(parsed, updates);
    await writePrivateConfigFileAtomic(
      resolvedConfigPath,
      formatConfigContents(nextParsed, resolvedConfigPath),
    );
  });

  return resolvedConfigPath;
}

function writePrivateConfigFile(configPath: string, contents: string): void {
  fs.writeFileSync(configPath, contents, { encoding: 'utf8', mode: 0o600 });
  enforcePrivateFilePermissions(configPath);
}

async function writePrivateConfigFileAtomic(configPath: string, contents: string): Promise<void> {
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await configIo.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

  try {
    await configIo.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    await configIo.rename(tempPath, configPath);
    enforcePrivateFilePermissions(configPath);
  } finally {
    await configIo.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function enforcePrivateFilePermissions(path: string): void {
  fs.chmodSync(path, 0o600);
}

function loadConfigFile(configPath: string): LooseRecord {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const loaded = yaml.load(fs.readFileSync(configPath, 'utf8'));
  return isRecord(loaded) ? loaded : {};
}

function buildResolvedConfig(parsed: LooseRecord): DaemonFullConfig {
  const baseDataDir = normalizePath(
    getEnvDataDir() ?? readString(getNestedValue(parsed, 'daemon', 'dataDir')) ?? resolve(homedir(), '.hivemind-os/collective'),
  );
  const hasExplicitIpcPath = readString(getNestedValue(parsed, 'daemon', 'ipcPath')) !== undefined;

  return applyEnvironmentOverrides(mergeConfig(buildDefaultConfig(baseDataDir), parsed), { hasExplicitIpcPath });
}

async function withConfigSaveLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = configSaveLocks.get(configPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  configSaveLocks.set(configPath, chain);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (configSaveLocks.get(configPath) === chain) {
      configSaveLocks.delete(configPath);
    }
  }
}

function collectConfigDiffs(current: unknown, next: unknown, path: string[] = []): ConfigDiff[] {
  if (isRecord(current) && isRecord(next)) {
    const diffs: ConfigDiff[] = [];
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);

    for (const key of keys) {
      const hasCurrent = Object.hasOwn(current, key);
      const hasNext = Object.hasOwn(next, key);
      if (!hasNext) {
        diffs.push({ path: [...path, key], delete: true });
        continue;
      }

      if (!hasCurrent) {
        diffs.push({ path: [...path, key], value: structuredClone(next[key]) });
        continue;
      }

      diffs.push(...collectConfigDiffs(current[key], next[key], [...path, key]));
    }

    return diffs;
  }

  return isDeepStrictEqual(current, next) ? [] : [{ path, value: structuredClone(next) }];
}

function applyConfigDiffs(parsed: LooseRecord, diffs: ConfigDiff[]): LooseRecord {
  const next = structuredClone(parsed);

  for (const diff of diffs) {
    if (diff.path.length === 0) {
      return isRecord(diff.value) ? structuredClone(diff.value) : {};
    }

    if (diff.delete) {
      deleteNestedValue(next, diff.path);
      continue;
    }

    setNestedValue(next, diff.path, structuredClone(diff.value));
  }

  return next;
}

function setNestedValue(record: LooseRecord, path: string[], value: unknown): void {
  let current = record;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as LooseRecord;
  }

  current[path[path.length - 1] as string] = value;
}

function deleteNestedValue(record: LooseRecord, path: string[]): void {
  const parents: Array<{ record: LooseRecord; key: string }> = [];
  let current: LooseRecord | undefined = record;

  for (const segment of path.slice(0, -1)) {
    if (!current || !isRecord(current[segment])) {
      return;
    }

    parents.push({ record: current, key: segment });
    current = current[segment] as LooseRecord;
  }

  if (!current) {
    return;
  }

  delete current[path[path.length - 1] as string];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index];
    const child = parent.record[parent.key];
    if (!isRecord(child) || Object.keys(child).length > 0) {
      break;
    }

    delete parent.record[parent.key];
  }
}

function formatConfigContents(config: LooseRecord, configPath: string): string {
  if (extname(configPath).toLowerCase() === '.json') {
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  return yaml.dump(config, { lineWidth: 120 });
}

function buildDefaultConfig(dataDir: string): DaemonFullConfig {
  const resolvedDataDir = normalizePath(dataDir);
  const defaultNetwork = NETWORK_PRESETS.testnet;

  return {
    network: {
      preset: 'testnet',
      rpcUrl: defaultNetwork.rpcUrl,
      faucetUrl: defaultNetwork.faucetUrl,
      packageId: defaultNetwork.packageId,
      registryId: defaultNetwork.registryId,
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
      limits: [{ amount: 1_000_000_000n, interval: 'day', currency: 'MIST' }],
    },
    payment: {
      preferredRail: 'auto',
      evm: {
        enabled: false,
        network: 'base',
      },
    },
    daemon: {
      ipcPath: getDefaultIpcPath(resolvedDataDir),
      dataDir: resolvedDataDir,
      pidFile: join(resolvedDataDir, 'daemon.pid'),
      logLevel: 'info',
    },
    relay: {
      enabled: false,
      endpoints: [],
      autoConnect: true,
      providerMode: false,
      reconnectIntervalMs: 5_000,
      heartbeatIntervalMs: 30_000,
    },
    blobstore: {
      mode: 'filesystem',
      filesystem: {
        dataDir: join(resolvedDataDir, 'blobs'),
      },
    },
    encryption: {
      enabled: true,
      requireEncryption: false,
    },
  };
}

function mergeConfig(defaults: DaemonFullConfig, parsed: LooseRecord): DaemonFullConfig {
  const network = isRecord(parsed.network) ? parsed.network : {};
  const identity = isRecord(parsed.identity) ? parsed.identity : {};
  const auth = isRecord(parsed.auth) ? parsed.auth : {};
  const payment = isRecord(parsed.payment) ? parsed.payment : {};
  const daemon = isRecord(parsed.daemon) ? parsed.daemon : {};
  const relay = isRecord(parsed.relay) ? parsed.relay : {};
  const blobstore = isRecord(parsed.blobstore) ? parsed.blobstore : {};
  const encryption = isRecord(parsed.encryption) ? parsed.encryption : {};
  const provider = isRecord(parsed.provider) ? parsed.provider : undefined;

  return {
    network: {
      ...resolveNetworkFromConfig(network, defaults.network),
    },
    identity: {
      dataDir: normalizePath(readString(identity.dataDir) ?? defaults.identity.dataDir),
    },
    auth: normalizeAuthConfig(auth, defaults.auth),
    spending: normalizeSpendingPolicy(parsed.spending, defaults.spending),
    payment: normalizePaymentConfig(payment, defaults.payment),
    daemon: {
      ipcPath: readString(daemon.ipcPath) ?? defaults.daemon.ipcPath,
      dataDir: normalizePath(readString(daemon.dataDir) ?? defaults.daemon.dataDir),
      pidFile: normalizePath(readString(daemon.pidFile) ?? defaults.daemon.pidFile),
      logLevel: normalizeLogLevel(daemon.logLevel, defaults.daemon.logLevel),
      logFile: readString(daemon.logFile) ? normalizePath(readString(daemon.logFile) as string) : undefined,
    },
    relay: normalizeRelayConfig(relay, defaults.relay),
    blobstore: normalizeBlobStoreConfig(blobstore, defaults.blobstore),
    encryption: normalizeEncryptionConfig(encryption, defaults.encryption),
    provider: normalizeProviderConfig(provider),
  };
}

function applyEnvironmentOverrides(
  config: DaemonFullConfig,
  options: { hasExplicitIpcPath: boolean } = { hasExplicitIpcPath: false },
): DaemonFullConfig {
  const envDataDir = getEnvDataDir();
  const envIpcPath = process.env.COLLECTIVE_IPC_PATH;
  const envPidFile = process.env.COLLECTIVE_PID_FILE;
  const withDataDir = envDataDir
    ? {
        ...config,
        identity: { dataDir: join(envDataDir, 'identity') },
        daemon: {
          ...config.daemon,
          dataDir: envDataDir,
          pidFile: envPidFile ?? join(envDataDir, 'daemon.pid'),
          ipcPath: envIpcPath ?? (options.hasExplicitIpcPath ? config.daemon.ipcPath : getDefaultIpcPath(envDataDir)),
        },
        blobstore: applyBlobStoreDataDirOverride(config.blobstore, join(envDataDir, 'blobs')),
      }
    : config;

  const withEnvOverrides = {
    ...withDataDir,
    daemon: {
      ...withDataDir.daemon,
      ...(envIpcPath && !envDataDir ? { ipcPath: envIpcPath } : {}),
      ...(envPidFile && !envDataDir ? { pidFile: envPidFile } : {}),
    },
  };

  return {
    ...withEnvOverrides,
    network: {
      ...withEnvOverrides.network,
      ...resolveNetworkEnvOverrides(withEnvOverrides.network),
    },
    daemon: {
      ...withEnvOverrides.daemon,
      logLevel: normalizeLogLevel(process.env.COLLECTIVE_LOG_LEVEL, withEnvOverrides.daemon.logLevel),
    },
  };
}

function resolveNetworkEnvOverrides(base: NetworkConfig): Partial<NetworkConfig> {
  // COLLECTIVE_NETWORK=testnet|mainnet|devnet|local applies a full preset
  const networkName = process.env.COLLECTIVE_NETWORK as NetworkName | undefined;
  const presetConfig = networkName ? getNetworkPreset(networkName) : undefined;
  const merged = presetConfig ? { ...base, ...presetConfig } : base;

  // Individual env vars override the preset
  return {
    preset: networkName ?? base.preset,
    rpcUrl: process.env.COLLECTIVE_RPC_URL ?? merged.rpcUrl,
    faucetUrl: merged.faucetUrl,
    packageId: process.env.COLLECTIVE_PACKAGE_ID ?? merged.packageId,
    registryId: process.env.COLLECTIVE_REGISTRY_ID ?? merged.registryId,
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

function normalizePaymentConfig(value: LooseRecord, defaults: PaymentConfig): PaymentConfig {
  const evm = isRecord(value.evm) ? value.evm : {};
  const preferredRail = readString(value.preferredRail);
  const network = readString(evm.network);

  return {
    preferredRail:
      preferredRail === 'sui' || preferredRail === 'x402' || preferredRail === 'auto'
        ? preferredRail
        : defaults.preferredRail,
    evm: {
      enabled: readBoolean(evm.enabled) ?? defaults.evm?.enabled ?? false,
      network:
        network === 'base' || network === 'base-sepolia' || network === 'localhost'
          ? network
          : (defaults.evm?.network ?? 'base'),
      rpcUrl: readString(evm.rpcUrl) ?? defaults.evm?.rpcUrl,
    },
  };
}

function normalizeRelayConfig(
  value: LooseRecord,
  defaults: DaemonFullConfig['relay'],
): DaemonFullConfig['relay'] {
  const endpoints = Array.isArray(value.endpoints)
    ? value.endpoints
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }

          const url = readString(entry.url);
          if (!url) {
            return null;
          }

          const relayDid = readString(entry.relayDid);
          return relayDid ? { url, relayDid } : { url };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : defaults.endpoints;

  return {
    enabled: readBoolean(value.enabled) ?? defaults.enabled,
    endpoints,
    autoConnect: readBoolean(value.autoConnect) ?? defaults.autoConnect,
    providerMode: readBoolean(value.providerMode) ?? defaults.providerMode,
    reconnectIntervalMs: readPositiveInteger(value.reconnectIntervalMs, 'relay.reconnectIntervalMs') ?? defaults.reconnectIntervalMs,
    heartbeatIntervalMs: readPositiveInteger(value.heartbeatIntervalMs, 'relay.heartbeatIntervalMs') ?? defaults.heartbeatIntervalMs,
  };
}

function normalizeEncryptionConfig(
  value: LooseRecord,
  defaults: DaemonFullConfig['encryption'],
): DaemonFullConfig['encryption'] {
  return {
    enabled: readBoolean(value.enabled) ?? defaults.enabled,
    requireEncryption: readBoolean(value.requireEncryption) ?? defaults.requireEncryption,
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
    currency: readString(value.currency)?.toUpperCase(),
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
    adapterConfig: isRecord(value.adapterConfig) ? value.adapterConfig : undefined,
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

  if (!config.payment.evm) {
    throw new Error('payment.evm configuration is required.');
  }

  if (!config.daemon.ipcPath || !config.daemon.dataDir || !config.daemon.pidFile) {
    throw new Error('daemon configuration is incomplete.');
  }

  if (config.relay.enabled && config.relay.endpoints.length === 0) {
    throw new Error('relay.endpoints must contain at least one entry when relay is enabled.');
  }

  for (const endpoint of config.relay.endpoints) {
    if (!/^wss?:\/\//i.test(endpoint.url)) {
      throw new Error(`Invalid relay endpoint URL: ${endpoint.url}`);
    }
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

  if (config.encryption.requireEncryption && !config.encryption.enabled) {
    throw new Error('encryption.requireEncryption cannot be true when encryption.enabled is false.');
  }
}

function serializeConfig(config: DaemonFullConfig): LooseRecord {
  return serializeValue(config) as LooseRecord;
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }

  return value;
}

function normalizeLogLevel(value: unknown, fallback: DaemonFullConfig['daemon']['logLevel']) {
  return typeof value === 'string' && LOG_LEVELS.has(value as DaemonFullConfig['daemon']['logLevel'])
    ? (value as DaemonFullConfig['daemon']['logLevel'])
    : fallback;
}

function normalizeRail(value: unknown): PaymentRail | undefined {
  if (
    value === PaymentRail.SUI_ESCROW ||
    value === PaymentRail.SUI_TRANSFER ||
    value === PaymentRail.X402_BASE
  ) {
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
  return process.env.COLLECTIVE_DATA_DIR ? normalizePath(process.env.COLLECTIVE_DATA_DIR) : undefined;
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

/**
 * Resolve the network config from YAML. If a `name` or `preset` field is present (e.g. "testnet"),
 * use the corresponding preset as the base, then overlay any explicit fields.
 */
function resolveNetworkFromConfig(network: LooseRecord, defaults: NetworkConfig): NetworkConfig {
  const nameField = readString(network.name) ?? readString(network.preset);
  const presetConfig = nameField ? getNetworkPreset(nameField) : undefined;
  const base = presetConfig ?? defaults;

  return {
    preset: nameField ?? defaults.preset,
    rpcUrl: readString(network.rpcUrl) ?? base.rpcUrl,
    faucetUrl: readString(network.faucetUrl) ?? base.faucetUrl,
    packageId: readHexString(network.packageId) ?? base.packageId,
    registryId: readHexString(network.registryId) ?? base.registryId,
  };
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
