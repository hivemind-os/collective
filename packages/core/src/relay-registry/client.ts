import pino from 'pino';

import { RelayNodeStatus, type RelayListFilters, type RelayNode } from '@hivemind-os/collective-types';
import type { SuiEvent, SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';

import { isRecord, normalizeMoveValue, parseRelayNodeFields } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildDeactivateRelayTx,
  buildHeartbeatRelayTx,
  buildRegisterRelayTx,
} from '../sui/tx-helpers.js';
import { StakingClient } from '../staking/client.js';

const logger = pino({ name: '@hivemind-os/collective-core:relay-registry' });

export interface RelayRegistryContractConfig {
  packageId: string;
  heartbeatFreshnessMs?: number;
}

export const DEFAULT_RELAY_HEARTBEAT_FRESHNESS_MS = 5 * 60_000;

export class RelayRegistryClient {
  private readonly stakingClient: StakingClient;
  private readonly heartbeatFreshnessMs: number;

  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: RelayRegistryContractConfig,
  ) {
    this.stakingClient = new StakingClient(suiClient, config);
    this.heartbeatFreshnessMs = config.heartbeatFreshnessMs ?? DEFAULT_RELAY_HEARTBEAT_FRESHNESS_MS;
  }

  async registerRelay(params: {
    endpoint: string;
    stakeId: string;
    capabilities: string[];
    region: string;
    routingFeeBps: number;
    signer: Signer;
  }): Promise<{ relayId: string; txDigest: string }> {
    const tx = buildRegisterRelayTx({
      packageId: this.config.packageId,
      endpoint: params.endpoint,
      stakeId: params.stakeId,
      capabilities: params.capabilities,
      region: params.region,
      routingFeeBps: params.routingFeeBps,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const relayId = readRelayId(response, `${this.config.packageId}::relay_registry::RelayRegistered`);
    if (!relayId) {
      logger.warn({ response }, 'Relay registration succeeded without a RelayNode object change.');
      throw new Error('Unable to determine relay id from transaction response.');
    }
    return { relayId, txDigest: response.digest };
  }

  async heartbeat(params: { relayId: string; signer: Signer }): Promise<{ lastHeartbeat: number; txDigest: string }> {
    const tx = buildHeartbeatRelayTx({ packageId: this.config.packageId, relayId: params.relayId });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::relay_registry::RelayHeartbeat`);
    return {
      lastHeartbeat: requireEventNumber(event, 'RelayHeartbeat', 'last_heartbeat', 'lastHeartbeat'),
      txDigest: response.digest,
    };
  }

  async recordRouting(params: { relayId: string; feeAmountMist: bigint; signer: Signer }): Promise<{ txDigest: string }> {
    void params;
    throw new Error('Relay routing metrics are package-internal and cannot be reported by external operators.');
  }

  async deactivateRelay(params: { relayId: string; signer: Signer }): Promise<{ txDigest: string }> {
    const tx = buildDeactivateRelayTx({ packageId: this.config.packageId, relayId: params.relayId });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async listRelays(filters: RelayListFilters = {}): Promise<RelayNode[]> {
    const relayIds = await this.collectRelayIds();
    const relays = await Promise.all([...relayIds].map(async (relayId) => await this.getRelay(relayId)));
    return relays
      .filter((relay): relay is RelayNode => Boolean(relay))
      .filter((relay) => matchesRelayFilters(relay, filters))
      .sort(compareRelays);
  }

  async getRelay(relayId: string): Promise<RelayNode | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(relayId);
      return await this.enrichRelay(parseRelayNodeFields(object, relayId));
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getRelaysByRegion(region: string): Promise<RelayNode[]> {
    return await this.listRelays({ region });
  }

  private async collectRelayIds(): Promise<Set<string>> {
    const relayIds = new Set<string>();
    const eventType = `${this.config.packageId}::relay_registry::RelayRegistered`;
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, 100);
      for (const event of page.events) {
        const payload = normalizeEvent(event);
        const relayId = asString(readEventField(payload, 'relay_id', 'relayId'));
        if (relayId) {
          relayIds.add(relayId);
        }
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return relayIds;
  }

  private async enrichRelay(relay: RelayNode): Promise<RelayNode> {
    const heartbeatAgeMs = Math.max(Date.now() - relay.lastHeartbeat, 0);
    try {
      const stake = await this.stakingClient.getStakePosition(relay.stakePositionId);
      return {
        ...relay,
        stakeAmountMist: stake?.balanceMist,
        heartbeatAgeMs,
        isHeartbeatFresh: heartbeatAgeMs <= this.heartbeatFreshnessMs,
      };
    } catch (error) {
      if (isObjectMissingError(error)) {
        logger.debug({ relayId: relay.id, stakePositionId: relay.stakePositionId }, 'Stake position not found.');
      } else {
        logger.warn({ err: error, relayId: relay.id, stakePositionId: relay.stakePositionId }, 'Unexpected error enriching relay with stake data.');
      }

      return {
        ...relay,
        heartbeatAgeMs,
        isHeartbeatFresh: heartbeatAgeMs <= this.heartbeatFreshnessMs,
      };
    }
  }
}

function readRelayId(response: SuiTransactionBlockResponse, eventType: string): string | undefined {
  const event = findEvent(response.events, eventType);
  return asString(readEventField(event, 'relay_id', 'relayId')) || extractObjectId(response, /::relay_registry::RelayNode$/);
}

function extractObjectId(response: SuiTransactionBlockResponse, objectTypePattern: RegExp): string | undefined {
  const change = (response.objectChanges as Array<Record<string, unknown>> | null | undefined)?.find(
    (entry) =>
      (entry.type === 'created' || entry.type === 'transferred' || entry.type === 'mutated') &&
      typeof entry.objectType === 'string' &&
      objectTypePattern.test(entry.objectType) &&
      typeof entry.objectId === 'string',
  );
  return change?.objectId as string | undefined;
}

function findEvent(events: SuiTransactionBlockResponse['events'], eventType: string): Record<string, unknown> {
  const payload = events
    ?.map((event) => ({ type: event.type, payload: normalizeEvent(event) }))
    .find((event) => event.type === eventType)?.payload;
  return payload ?? {};
}

function normalizeEvent(event: SuiEvent): Record<string, unknown> {
  const normalized = normalizeMoveValue(event.parsedJson);
  return isRecord(normalized) ? normalized : {};
}

function readEventField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return Number(value);
  }
  return 0;
}

function requireEventNumber(record: Record<string, unknown>, eventName: string, ...keys: string[]): number {
  const raw = readEventField(record, ...keys);
  if (raw == null || raw === '') {
    throw new Error(`${eventName} event did not include a valid ${keys[0]}.`);
  }
  const value = asNumber(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${eventName} event did not include a valid ${keys[0]}.`);
  }
  return value;
}

function matchesRelayFilters(relay: RelayNode, filters: RelayListFilters): boolean {
  const activeOnly = filters.status === undefined && filters.activeOnly === undefined ? true : (filters.activeOnly ?? false);
  const statuses = normalizeStatuses(filters.status, activeOnly);
  if (!statuses.includes(relay.status)) {
    return false;
  }
  if (filters.operator && relay.operator.toLowerCase() !== filters.operator.toLowerCase()) {
    return false;
  }
  if (filters.region && relay.region.toLowerCase() !== filters.region.toLowerCase()) {
    return false;
  }
  if (filters.stakePositionId && relay.stakePositionId.toLowerCase() !== filters.stakePositionId.toLowerCase()) {
    return false;
  }
  if (filters.endpoint && relay.endpoint.toLowerCase() !== filters.endpoint.toLowerCase()) {
    return false;
  }
  if (filters.capability) {
    const capability = filters.capability.toLowerCase();
    if (!relay.capabilities.some((entry) => entry.toLowerCase() === capability)) {
      return false;
    }
  }
  if (filters.heartbeatWithinMs !== undefined && (relay.heartbeatAgeMs ?? Number.POSITIVE_INFINITY) > filters.heartbeatWithinMs) {
    return false;
  }
  return true;
}

function normalizeStatuses(status: RelayListFilters['status'], activeOnly: boolean): RelayNodeStatus[] {
  if (Array.isArray(status)) {
    return status;
  }
  if (status !== undefined) {
    return [status];
  }
  return activeOnly
    ? [RelayNodeStatus.ACTIVE]
    : [RelayNodeStatus.ACTIVE, RelayNodeStatus.INACTIVE, RelayNodeStatus.SLASHED];
}

function compareRelays(left: RelayNode, right: RelayNode): number {
  return (
    compareBoolean(left.status === RelayNodeStatus.ACTIVE, right.status === RelayNodeStatus.ACTIVE) ||
    compareBoolean(left.isHeartbeatFresh ?? false, right.isHeartbeatFresh ?? false) ||
    compareNumber(left.routingFeeBps, right.routingFeeBps, true) ||
    compareBigInt(left.stakeAmountMist ?? 0n, right.stakeAmountMist ?? 0n) ||
    compareNumber(left.lastHeartbeat, right.lastHeartbeat)
  );
}

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) {
    return 0;
  }
  return left ? -1 : 1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function compareNumber(left: number, right: number, ascending = false): number {
  if (left === right) {
    return 0;
  }
  if (ascending) {
    return left < right ? -1 : 1;
  }
  return left > right ? -1 : 1;
}

function isObjectMissingError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (err.code === 'objectNotFound' || err.code === 'notExists') {
      return true;
    }
    if (typeof err.data === 'object' && err.data !== null) {
      const data = err.data as Record<string, unknown>;
      if (data.code === -32000 || data.code === 'objectNotFound') {
        return true;
      }
    }
  }

  return error instanceof Error && /could not find.*object|object.*not found|does not exist|no data.*objectId|dynamicFieldNotFound|does not contain move object data/i.test(error.message);
}
