import { randomUUID } from 'node:crypto';

import { RelayNodeStatus, type RelayNode } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';

export const PROTOCOL_VERSION = '1.0.0';

export function isProtocolVersionCompatible(version: string): boolean {
  const [major] = version.split('.');
  return major === '1';
}

export function createRelayNodeFixture(overrides: Partial<RelayNode> = {}): RelayNode {
  return {
    id: randomObjectId(),
    operator: randomObjectId(),
    endpoint: 'wss://relay.mesh.example/ws',
    stakePositionId: randomObjectId(),
    capabilities: ['routing'],
    region: 'us-east',
    status: RelayNodeStatus.ACTIVE,
    registeredAt: 1_000,
    lastHeartbeat: 2_000,
    routingFeeBps: 50,
    totalRouted: 3,
    totalFeesEarnedMist: 150_000_000n,
    ...overrides,
  };
}

export function createRelayRegisteredEvent(packageId: string, relay: Partial<RelayNode> = {}): SuiEvent {
  const value = createRelayNodeFixture(relay);
  return {
    id: { txDigest: '0xtx', eventSeq: '0' },
    packageId,
    transactionModule: 'relay_registry',
    sender: value.operator,
    type: `${packageId}::relay_registry::RelayRegistered`,
    parsedJson: {
      relay_id: value.id,
      operator: value.operator,
      endpoint: value.endpoint,
      stake_position_id: value.stakePositionId,
      capabilities: value.capabilities,
      region: value.region,
      status: 'ACTIVE',
      registered_at: value.registeredAt,
      last_heartbeat: value.lastHeartbeat,
      routing_fee_bps: value.routingFeeBps,
      total_routed: value.totalRouted,
      total_fees_earned: value.totalFeesEarnedMist.toString(),
    },
    bcs: '',
    timestampMs: String(value.lastHeartbeat),
  } as unknown as SuiEvent;
}

export function createRelayRegisteredEventV1_1(packageId: string, relay: Partial<RelayNode> = {}): SuiEvent {
  const value = createRelayNodeFixture(relay);
  return {
    id: { txDigest: '0xtx-v11', eventSeq: '1' },
    packageId,
    transactionModule: 'relay_registry',
    sender: value.operator,
    type: `${packageId}::relay_registry::RelayRegistered`,
    parsedJson: {
      relayId: value.id,
      operator: value.operator,
      endpoint: value.endpoint,
      stakePositionId: value.stakePositionId,
      capabilities: value.capabilities,
      region: value.region,
      status: 'ACTIVE',
      registeredAt: value.registeredAt,
      lastHeartbeat: value.lastHeartbeat,
      routingFeeBps: value.routingFeeBps,
      totalRouted: value.totalRouted,
      totalFeesEarnedMist: value.totalFeesEarnedMist.toString(),
    },
    bcs: '',
    timestampMs: String(value.lastHeartbeat),
  } as unknown as SuiEvent;
}

function randomObjectId(): string {
  return `0x${randomUUID().replace(/-/g, '').slice(0, 40)}`;
}
