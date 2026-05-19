import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { MeshSuiClient, RelayNodeStatus, RelayRegistryClient, type RelayNode } from '@hivemind-os/collective-core';

import type { RelayConfig } from '../config.js';
import { RelayIdentity } from '../identity/relay-identity.js';

export interface RelayRegistryRuntimeInfo {
  enabled: boolean;
  registered: boolean;
  relayId?: string;
  operator?: string;
  endpoint?: string;
  stakePositionId?: string;
  capabilities?: string[];
  region?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'SLASHED';
  routingFeeBps?: number;
  lastHeartbeat?: number;
  totalRouted?: number;
  totalFeesEarnedMist?: string;
  lastError?: string;
}

export interface RelayRegistryRuntime {
  start: (serverAddress: string) => Promise<void>;
  stop: () => Promise<void>;
  recordRouting: (feeAmountMist: bigint) => Promise<void>;
  getInfo: () => RelayRegistryRuntimeInfo;
}

export class RelayRegistryService implements RelayRegistryRuntime {
  private readonly enabled: boolean;
  private readonly signer: Ed25519Keypair;
  private readonly client?: RelayRegistryClient;
  private heartbeatTimer?: NodeJS.Timeout;
  private state: RelayRegistryRuntimeInfo;

  constructor(
    private readonly config: RelayConfig,
    private readonly identity: RelayIdentity,
    client?: RelayRegistryClient,
  ) {
    this.enabled = Boolean(config.relayRegistry?.enabled && config.sui?.rpcUrl && config.sui.packageId && config.relayRegistry.stakePositionId);
    this.signer = Ed25519Keypair.fromSecretKey(identity.keypair.secretKey);
    this.client = client ?? (this.enabled ? new RelayRegistryClient(createRelaySuiClient(config), { packageId: config.sui?.packageId ?? '' }) : undefined);
    this.state = {
      enabled: this.enabled,
      registered: false,
      capabilities: config.relayRegistry?.capabilities ?? [],
      region: config.relayRegistry?.region,
      stakePositionId: config.relayRegistry?.stakePositionId,
      endpoint: config.relayRegistry?.endpoint,
      routingFeeBps: config.relayRegistry?.routingFeeBps,
    };
  }

  async start(serverAddress: string): Promise<void> {
    if (!this.enabled || !this.client || !this.config.relayRegistry?.stakePositionId) {
      return;
    }

    const endpoint = resolveRelayEndpoint(this.config, serverAddress);
    this.state.endpoint = endpoint;
    this.state.capabilities = this.config.relayRegistry.capabilities;
    this.state.region = this.config.relayRegistry.region;
    this.state.stakePositionId = this.config.relayRegistry.stakePositionId;
    this.state.routingFeeBps = resolveRoutingFeeBps(this.config);
    this.state.operator = this.signer.getPublicKey().toSuiAddress();

    try {
      const existing = await this.resolveExistingRelay(endpoint);
      if (existing) {
        this.applyRelay(existing);
      } else {
        const registered = await this.client.registerRelay({
          endpoint,
          stakeId: this.config.relayRegistry.stakePositionId,
          capabilities: this.config.relayRegistry.capabilities,
          region: this.config.relayRegistry.region ?? 'global',
          routingFeeBps: resolveRoutingFeeBps(this.config),
          signer: this.signer,
        });
        await this.refreshRelay(registered.relayId);
      }

      await this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        void this.sendHeartbeat();
      }, this.config.relayRegistry.heartbeatIntervalMs);
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  async recordRouting(feeAmountMist: bigint): Promise<void> {
    if (!this.state.relayId) {
      return;
    }
    if (feeAmountMist < 0n) {
      throw new Error('feeAmountMist must be non-negative.');
    }

    this.state.totalRouted = (this.state.totalRouted ?? 0) + 1;
    this.state.totalFeesEarnedMist = ((BigInt(this.state.totalFeesEarnedMist ?? '0') + feeAmountMist)).toString();
    this.state.lastError = undefined;
  }

  getInfo(): RelayRegistryRuntimeInfo {
    return { ...this.state };
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.client || !this.state.relayId) {
      return;
    }

    try {
      const result = await this.client.heartbeat({ relayId: this.state.relayId, signer: this.signer });
      this.state.lastHeartbeat = result.lastHeartbeat;
      this.state.lastError = undefined;
      await this.refreshRelay(this.state.relayId);
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async resolveExistingRelay(endpoint: string): Promise<RelayNode | null> {
    if (!this.client || !this.config.relayRegistry) {
      return null;
    }

    if (this.config.relayRegistry.relayId) {
      return await this.client.getRelay(this.config.relayRegistry.relayId);
    }

    const operator = this.signer.getPublicKey().toSuiAddress();
    const matches = await this.client.listRelays({
      activeOnly: false,
      operator,
      stakePositionId: this.config.relayRegistry.stakePositionId,
      endpoint,
    });
    return matches.find((relay) => relay.status === RelayNodeStatus.ACTIVE) ?? matches[0] ?? null;
  }

  private async refreshRelay(relayId: string): Promise<void> {
    if (!this.client) {
      return;
    }
    const relay = await this.client.getRelay(relayId);
    if (relay) {
      this.applyRelay(relay);
    }
  }

  private applyRelay(relay: RelayNode): void {
    this.state = {
      ...this.state,
      enabled: true,
      registered: true,
      relayId: relay.id,
      operator: relay.operator,
      endpoint: relay.endpoint,
      stakePositionId: relay.stakePositionId,
      capabilities: relay.capabilities,
      region: relay.region,
      status: relayStatusToText(relay.status),
      routingFeeBps: relay.routingFeeBps,
      lastHeartbeat: relay.lastHeartbeat,
      totalRouted: relay.totalRouted,
      totalFeesEarnedMist: relay.totalFeesEarnedMist.toString(),
      lastError: undefined,
    };
  }
}

function createRelaySuiClient(config: RelayConfig): MeshSuiClient {
  return new MeshSuiClient({
    rpcUrl: config.sui?.rpcUrl ?? '',
    faucetUrl: config.sui?.rpcUrl ?? '',
    packageId: config.sui?.packageId ?? '',
    registryId: config.sui?.packageId ?? '',
  });
}

function resolveRelayEndpoint(config: RelayConfig, serverAddress: string): string {
  if (config.relayRegistry?.endpoint) {
    return config.relayRegistry.endpoint;
  }

  const url = new URL(serverAddress);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function resolveRoutingFeeBps(config: RelayConfig): number {
  return config.relayRegistry?.routingFeeBps ?? Math.max(0, Math.round(config.fees.basePercentage * 100));
}

function relayStatusToText(status: RelayNodeStatus): RelayRegistryRuntimeInfo['status'] {
  switch (status) {
    case RelayNodeStatus.INACTIVE:
      return 'INACTIVE';
    case RelayNodeStatus.SLASHED:
      return 'SLASHED';
    default:
      return 'ACTIVE';
  }
}
