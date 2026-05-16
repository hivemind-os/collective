import type { StakePosition } from '@hivemind-os/collective-types';
import type { SuiEvent, SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { isRecord, normalizeMoveValue, parseStakePositionFields } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildAddStakeTx,
  buildDepositStakeTx,
  buildSlashExpiredEscrowTx,
  buildSlashNonDeliveryTx,
  buildStartDeactivationTx,
  buildWithdrawStakeTx,
} from '../sui/tx-helpers.js';

export interface StakingContractConfig {
  packageId: string;
}

export const STAKING_COOLDOWN_MS = 604_800_000;

export class StakingClient {
  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: StakingContractConfig,
  ) {}

  async depositStake(params: {
    amountMist: bigint;
    stakeType: 'agent' | 'relay';
    signer: Ed25519Keypair;
  }): Promise<{ stakeId: string; txDigest: string }> {
    const tx = buildDepositStakeTx({
      packageId: this.config.packageId,
      amountMist: params.amountMist,
      stakeType: params.stakeType,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const stakeId = readStakeId(response, `${this.config.packageId}::staking::StakeDeposited`);
    if (!stakeId) {
      throw new Error('Unable to determine stake id from transaction response.');
    }
    return { stakeId, txDigest: response.digest };
  }

  async addStake(params: {
    stakeId: string;
    amountMist: bigint;
    signer: Ed25519Keypair;
  }): Promise<{ txDigest: string }> {
    const tx = buildAddStakeTx({
      packageId: this.config.packageId,
      stakeId: params.stakeId,
      amountMist: params.amountMist,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async startDeactivation(params: {
    stakeId: string;
    signer: Ed25519Keypair;
  }): Promise<{ cooldownEndsAt: number; txDigest: string }> {
    const tx = buildStartDeactivationTx({
      packageId: this.config.packageId,
      stakeId: params.stakeId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::staking::DeactivationStarted`);
    return {
      cooldownEndsAt: requireEventNumber(event, 'DeactivationStarted', 'cooldown_ends_at', 'cooldownEndsAt'),
      txDigest: response.digest,
    };
  }

  async withdrawStake(params: {
    stakeId: string;
    signer: Ed25519Keypair;
  }): Promise<{ amountReturned: bigint; txDigest: string }> {
    const tx = buildWithdrawStakeTx({
      packageId: this.config.packageId,
      stakeId: params.stakeId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::staking::StakeWithdrawn`);
    return {
      amountReturned: requireEventBigInt(event, 'StakeWithdrawn', 'amount'),
      txDigest: response.digest,
    };
  }

  async slashExpiredEscrow(params: {
    stakeId: string;
    taskId: string;
    signer: Ed25519Keypair;
  }): Promise<{ slashedAmount: bigint; txDigest: string }> {
    const tx = buildSlashExpiredEscrowTx({
      packageId: this.config.packageId,
      stakeId: params.stakeId,
      taskId: params.taskId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::staking::StakeSlashed`);
    return {
      slashedAmount: requireEventBigInt(event, 'StakeSlashed', 'amount'),
      txDigest: response.digest,
    };
  }

  async slashNonDelivery(params: {
    stakeId: string;
    taskId: string;
    signer: Ed25519Keypair;
  }): Promise<{ slashedAmount: bigint; txDigest: string }> {
    const tx = buildSlashNonDeliveryTx({
      packageId: this.config.packageId,
      stakeId: params.stakeId,
      taskId: params.taskId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::staking::StakeSlashed`);
    return {
      slashedAmount: requireEventBigInt(event, 'StakeSlashed', 'amount'),
      txDigest: response.digest,
    };
  }

  async getStakePosition(stakeId: string): Promise<StakePosition | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(stakeId);
      return parseStakePositionFields(object, stakeId);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getStakeByOwner(owner: string): Promise<StakePosition | null> {
    const positions = await this.getStakeByOwners([owner]);
    return positions.get(owner) ?? null;
  }

  async getStakeByOwners(owners: string[]): Promise<Map<string, StakePosition>> {
    const ownerFilter = new Set(owners.map((owner) => owner.toLowerCase()));
    if (ownerFilter.size === 0) {
      return new Map();
    }

    const stakeEventType = `${this.config.packageId}::staking::StakeDeposited`;
    const stakeIdsByOwner = new Map<string, Set<string>>();
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(stakeEventType, cursor, 100);
      for (const event of page.events) {
        const payload = normalizeEvent(event);
        const eventOwner = asString(readEventField(payload, 'owner')).toLowerCase();
        if (!ownerFilter.has(eventOwner)) {
          continue;
        }
        const stakeId = asString(readEventField(payload, 'stake_id', 'stakeId'));
        if (!stakeId) {
          continue;
        }
        const existing = stakeIdsByOwner.get(eventOwner) ?? new Set<string>();
        existing.add(stakeId);
        stakeIdsByOwner.set(eventOwner, existing);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    const normalizedResults = new Map<string, StakePosition>();
    await Promise.all(
      [...stakeIdsByOwner.entries()].map(async ([normalizedOwner, ids]) => {
        const positions = await Promise.all([...ids].map(async (stakeId) => await this.getStakePosition(stakeId)));
        const best = positions.filter((position): position is StakePosition => Boolean(position)).sort(compareStakePositions)[0];
        if (best) {
          normalizedResults.set(normalizedOwner, best);
        }
      }),
    );

    return new Map(
      owners
        .map((owner) => [owner, normalizedResults.get(owner.toLowerCase())] as const)
        .filter((entry): entry is readonly [string, StakePosition] => Boolean(entry[1])),
    );
  }
}

function compareStakePositions(left: StakePosition, right: StakePosition): number {
  return (
    compareBoolean(left.isActive ?? false, right.isActive ?? false) ||
    compareBoolean(left.meetsMinium ?? false, right.meetsMinium ?? false) ||
    compareBigInt(left.balanceMist, right.balanceMist) ||
    compareNumber(left.stakedAt, right.stakedAt)
  );
}

function readStakeId(response: SuiTransactionBlockResponse, eventType: string): string | undefined {
  const event = findEvent(response.events, eventType);
  return asString(readEventField(event, 'stake_id', 'stakeId')) || extractObjectId(response, /::staking::StakePosition$/);
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

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function requireEventBigInt(record: Record<string, unknown>, eventName: string, ...keys: string[]): bigint {
  const raw = readEventField(record, ...keys);
  if (raw == null || raw === '') {
    throw new Error(`${eventName} event did not include ${keys[0]}.`);
  }
  try {
    return asBigInt(raw);
  } catch {
    throw new Error(`${eventName} event did not include a valid ${keys[0]}.`);
  }
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

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function isObjectMissingError(error: unknown): boolean {
  return error instanceof Error && /not found|does not contain move object data/i.test(error.message);
}
