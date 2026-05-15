import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RelayConfig {
  host: string;
  port: number;
  identity: {
    keyPath: string;
  };
  fees: {
    basePercentage: number;
    minimumMist: bigint;
  };
  limits: {
    maxConnections: number;
    maxRequestsPerSecond: number;
    taskTimeoutMs: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    authNonceTtlMs: number;
  };
  cors?: {
    allowedOrigins: string[];
  };
  sui?: {
    rpcUrl: string;
    packageId: string;
  };
  relayRegistry?: {
    enabled: boolean;
    relayId?: string;
    stakePositionId?: string;
    endpoint?: string;
    capabilities: string[];
    region?: string;
    routingFeeBps?: number;
    heartbeatIntervalMs: number;
  };
}

export function getDefaultRelayConfig(baseDir = resolve(homedir(), '.agentic-mesh', 'relay')): RelayConfig {
  return {
    host: '0.0.0.0',
    port: 8080,
    identity: {
      keyPath: join(baseDir, 'identity.key'),
    },
    fees: {
      basePercentage: 5,
      minimumMist: 1_000n,
    },
    limits: {
      maxConnections: 1_000,
      maxRequestsPerSecond: 100,
      taskTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      authNonceTtlMs: 5 * 60_000,
    },
    cors: {
      allowedOrigins: [],
    },
  };
}

export function loadRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  const dataDir = process.env.MESH_RELAY_DATA_DIR ? resolve(process.env.MESH_RELAY_DATA_DIR) : undefined;
  const defaults = getDefaultRelayConfig(dataDir);

  const config: RelayConfig = {
    host: process.env.MESH_RELAY_HOST ?? overrides.host ?? defaults.host,
    port: readNumber(process.env.MESH_RELAY_PORT) ?? overrides.port ?? defaults.port,
    identity: {
      keyPath: resolve(overrides.identity?.keyPath ?? process.env.MESH_RELAY_KEY_PATH ?? defaults.identity.keyPath),
    },
    fees: {
      basePercentage:
        readNumber(process.env.MESH_RELAY_FEE_PERCENT) ?? overrides.fees?.basePercentage ?? defaults.fees.basePercentage,
      minimumMist:
        readBigInt(process.env.MESH_RELAY_MINIMUM_MIST) ?? overrides.fees?.minimumMist ?? defaults.fees.minimumMist,
    },
    limits: {
      maxConnections:
        readNumber(process.env.MESH_RELAY_MAX_CONNECTIONS) ??
        overrides.limits?.maxConnections ??
        defaults.limits.maxConnections,
      maxRequestsPerSecond:
        readNumber(process.env.MESH_RELAY_MAX_RPS) ??
        overrides.limits?.maxRequestsPerSecond ??
        defaults.limits.maxRequestsPerSecond,
      taskTimeoutMs:
        readNumber(process.env.MESH_RELAY_TASK_TIMEOUT_MS) ??
        overrides.limits?.taskTimeoutMs ??
        defaults.limits.taskTimeoutMs,
      heartbeatIntervalMs:
        readNumber(process.env.MESH_RELAY_HEARTBEAT_INTERVAL_MS) ??
        overrides.limits?.heartbeatIntervalMs ??
        defaults.limits.heartbeatIntervalMs,
      heartbeatTimeoutMs:
        readNumber(process.env.MESH_RELAY_HEARTBEAT_TIMEOUT_MS) ??
        overrides.limits?.heartbeatTimeoutMs ??
        defaults.limits.heartbeatTimeoutMs,
      authNonceTtlMs:
        readNumber(process.env.MESH_RELAY_AUTH_NONCE_TTL_MS) ??
        overrides.limits?.authNonceTtlMs ??
        defaults.limits.authNonceTtlMs,
    },
    cors: {
      allowedOrigins:
        overrides.cors?.allowedOrigins ??
        readStringList(process.env.MESH_RELAY_ALLOWED_ORIGINS) ??
        defaults.cors?.allowedOrigins ??
        [],
    },
    sui:
      overrides.sui || process.env.MESH_RELAY_SUI_RPC_URL || process.env.MESH_RELAY_SUI_PACKAGE_ID
        ? {
            rpcUrl: overrides.sui?.rpcUrl ?? process.env.MESH_RELAY_SUI_RPC_URL ?? '',
            packageId: overrides.sui?.packageId ?? process.env.MESH_RELAY_SUI_PACKAGE_ID ?? '',
          }
        : undefined,
    relayRegistry:
      overrides.relayRegistry ||
      process.env.MESH_RELAY_REGISTRY_ENABLED ||
      process.env.MESH_RELAY_REGISTRY_STAKE_ID ||
      process.env.MESH_RELAY_REGISTRY_RELAY_ID
        ? {
            enabled: readBoolean(process.env.MESH_RELAY_REGISTRY_ENABLED) ?? overrides.relayRegistry?.enabled ?? true,
            relayId: overrides.relayRegistry?.relayId ?? process.env.MESH_RELAY_REGISTRY_RELAY_ID,
            stakePositionId: overrides.relayRegistry?.stakePositionId ?? process.env.MESH_RELAY_REGISTRY_STAKE_ID,
            endpoint: overrides.relayRegistry?.endpoint ?? process.env.MESH_RELAY_REGISTRY_ENDPOINT,
            capabilities:
              overrides.relayRegistry?.capabilities ?? readStringList(process.env.MESH_RELAY_REGISTRY_CAPABILITIES) ?? [],
            region: overrides.relayRegistry?.region ?? process.env.MESH_RELAY_REGISTRY_REGION,
            routingFeeBps:
              readNumber(process.env.MESH_RELAY_REGISTRY_FEE_BPS) ?? overrides.relayRegistry?.routingFeeBps,
            heartbeatIntervalMs:
              readNumber(process.env.MESH_RELAY_REGISTRY_HEARTBEAT_INTERVAL_MS) ??
              overrides.relayRegistry?.heartbeatIntervalMs ??
              defaults.limits.heartbeatIntervalMs,
          }
        : undefined,
  };

  validateRelayConfig(config);
  return config;
}

export function validateRelayConfig(config: RelayConfig): void {
  if (!config.host) {
    throw new Error('Relay host is required.');
  }

  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('Relay port must be a positive integer.');
  }

  if (!config.identity.keyPath) {
    throw new Error('Relay identity keyPath is required.');
  }

  if (config.fees.basePercentage < 0) {
    throw new Error('Relay base fee percentage must be non-negative.');
  }

  if (config.fees.minimumMist < 0n) {
    throw new Error('Relay minimum fee must be non-negative.');
  }

  for (const [name, value] of Object.entries(config.limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Relay limit ${name} must be a positive integer.`);
    }
  }

  if (config.cors && config.cors.allowedOrigins.some((origin) => origin.trim().length === 0)) {
    throw new Error('Relay CORS allowed origins must be non-empty strings.');
  }

  if (!config.relayRegistry || config.relayRegistry.enabled === false) {
    return;
  }

  if (!config.sui?.rpcUrl || !config.sui.packageId) {
    throw new Error('Relay registry integration requires sui.rpcUrl and sui.packageId.');
  }

  if (config.relayRegistry.stakePositionId && !/^0x[0-9a-f]+$/i.test(config.relayRegistry.stakePositionId)) {
    throw new Error('Relay registry stakePositionId must be a 0x-prefixed object id.');
  }

  if (config.relayRegistry.relayId && !/^0x[0-9a-f]+$/i.test(config.relayRegistry.relayId)) {
    throw new Error('Relay registry relayId must be a 0x-prefixed object id.');
  }

  if (config.relayRegistry.routingFeeBps !== undefined) {
    if (!Number.isInteger(config.relayRegistry.routingFeeBps) || config.relayRegistry.routingFeeBps < 0 || config.relayRegistry.routingFeeBps > 10_000) {
      throw new Error('Relay registry routingFeeBps must be an integer between 0 and 10000.');
    }
  }

  if (!Number.isInteger(config.relayRegistry.heartbeatIntervalMs) || config.relayRegistry.heartbeatIntervalMs <= 0) {
    throw new Error('Relay registry heartbeat interval must be a positive integer.');
  }
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBigInt(value: string | undefined): bigint | undefined {
  if (!value) {
    return undefined;
  }

  return /^\d+$/.test(value.trim()) ? BigInt(value.trim()) : undefined;
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return undefined;
}

function readStringList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : undefined;
}
