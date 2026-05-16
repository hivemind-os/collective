import { RelayNodeStatus, type RelayNode } from '@hivemind-os/collective-types';

import { DEFAULT_RELAY_HEARTBEAT_FRESHNESS_MS, type RelayRegistryClient } from './client.js';

export interface RelayDiscoveryOptions {
  cacheTtlMs?: number;
  heartbeatFreshnessMs?: number;
  now?: () => number;
}

interface RelayCacheEntry {
  relays: RelayNode[];
  expiresAt: number;
}

export class RelayDiscovery {
  private readonly cacheTtlMs: number;
  private readonly heartbeatFreshnessMs: number;
  private readonly now: () => number;
  private cache?: RelayCacheEntry;

  constructor(
    private readonly registryClient: Pick<RelayRegistryClient, 'listRelays'>,
    options: RelayDiscoveryOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.heartbeatFreshnessMs = options.heartbeatFreshnessMs ?? DEFAULT_RELAY_HEARTBEAT_FRESHNESS_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async findBestRelay(capability: string, region?: string): Promise<RelayNode | null> {
    const normalizedCapability = capability.trim().toLowerCase();
    if (!normalizedCapability) {
      throw new Error('capability must be a non-empty string.');
    }

    const normalizedRegion = region?.trim() || undefined;
    const relays = (await this.getRelayList())
      .filter((relay) => relay.status === RelayNodeStatus.ACTIVE)
      .filter((relay) => relay.capabilities.some((entry) => entry.toLowerCase() === normalizedCapability));

    if (relays.length === 0) {
      return null;
    }

    return [...relays].sort(
      (left, right) => scoreRelay(right, normalizedRegion, this.heartbeatFreshnessMs, this.now())
        - scoreRelay(left, normalizedRegion, this.heartbeatFreshnessMs, this.now()),
    )[0] ?? null;
  }

  invalidateCache(): void {
    this.cache = undefined;
  }

  private async getRelayList(): Promise<RelayNode[]> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.relays.map((relay) => ({ ...relay }));
    }

    const relays = (await this.registryClient.listRelays({ activeOnly: true })).map((relay) => ({ ...relay }));
    this.cache = {
      relays,
      expiresAt: now + this.cacheTtlMs,
    };
    return relays.map((relay) => ({ ...relay }));
  }
}

function scoreRelay(relay: RelayNode, region: string | undefined, heartbeatFreshnessMs: number, now: number): number {
  const feeScore = Math.max(0, 1 - relay.routingFeeBps / 10_000);
  const regionScore = scoreRegion(relay.region, region);
  const stakeScore = scoreStake(relay.stakeAmountMist ?? 0n);
  const freshnessScore = scoreHeartbeat(relay.heartbeatAgeMs ?? Math.max(now - relay.lastHeartbeat, 0), heartbeatFreshnessMs);

  return feeScore * 0.35 + regionScore * 0.25 + stakeScore * 0.2 + freshnessScore * 0.2;
}

function scoreRegion(relayRegion: string, desiredRegion: string | undefined): number {
  if (!desiredRegion) {
    return 0.5;
  }

  const normalizedRelayRegion = relayRegion.trim().toLowerCase();
  const normalizedDesiredRegion = desiredRegion.trim().toLowerCase();
  if (normalizedRelayRegion === normalizedDesiredRegion) {
    return 1;
  }

  const relayPrefix = normalizedRelayRegion.split(/[-_\s]/)[0];
  const desiredPrefix = normalizedDesiredRegion.split(/[-_\s]/)[0];
  return relayPrefix && relayPrefix === desiredPrefix ? 0.65 : 0;
}

function scoreStake(stakeAmountMist: bigint): number {
  const capped = stakeAmountMist > 1_000_000_000_000n ? 1_000_000_000_000n : stakeAmountMist;
  return Number(capped) / Number(1_000_000_000_000n);
}

function scoreHeartbeat(heartbeatAgeMs: number, heartbeatFreshnessMs: number): number {
  if (heartbeatAgeMs <= heartbeatFreshnessMs) {
    return 1;
  }
  if (heartbeatAgeMs >= heartbeatFreshnessMs * 4) {
    return 0;
  }
  return 1 - (heartbeatAgeMs - heartbeatFreshnessMs) / (heartbeatFreshnessMs * 3);
}
