import type { Dispute, NetworkConfig } from '@agentic-mesh/types';
import type { SuiEvent, SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { isRecord, normalizeMoveValue, parseDisputeFields } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildAcceptResolutionTx,
  buildArbitrateDisputeTx,
  buildOpenDisputeTx,
  buildRespondToDisputeTx,
} from '../sui/tx-helpers.js';

export class DisputeClient {
  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: Pick<NetworkConfig, 'packageId'>,
  ) {}

  async openDispute(params: {
    taskId: string;
    evidenceBlobId: string;
    proposedSplitMist: bigint;
    arbitratorAddress?: string;
    signer: Ed25519Keypair;
  }): Promise<{ disputeId: string; txDigest: string }> {
    const tx = buildOpenDisputeTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      evidenceBlobId: params.evidenceBlobId,
      proposedSplitMist: params.proposedSplitMist,
      arbitratorAddress: params.arbitratorAddress,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const disputeId =
      extractObjectId(response, /::dispute::Dispute$/)
      ?? asString(readEventField(findEvent(response.events, `${this.config.packageId}::dispute::DisputeOpened`), 'dispute_id', 'disputeId'));
    if (!disputeId) {
      throw new Error('Unable to determine dispute id from transaction response.');
    }
    return { disputeId, txDigest: response.digest };
  }

  async respondToDispute(params: {
    disputeId: string;
    evidenceBlobId: string;
    proposedSplitMist: bigint;
    signer: Ed25519Keypair;
  }): Promise<{ txDigest: string }> {
    const tx = buildRespondToDisputeTx({
      packageId: this.config.packageId,
      disputeId: params.disputeId,
      evidenceBlobId: params.evidenceBlobId,
      proposedSplitMist: params.proposedSplitMist,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async acceptResolution(params: {
    disputeId: string;
    taskId: string;
    signer: Ed25519Keypair;
  }): Promise<{ requesterAmount: bigint; providerAmount: bigint; txDigest: string }> {
    const tx = buildAcceptResolutionTx({
      packageId: this.config.packageId,
      disputeId: params.disputeId,
      taskId: params.taskId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const event = findEvent(response.events, `${this.config.packageId}::dispute::DisputeMutuallyResolved`);
    return {
      requesterAmount: requireEventBigInt(event, 'DisputeMutuallyResolved', 'requester_amount', 'requesterAmount'),
      providerAmount: requireEventBigInt(event, 'DisputeMutuallyResolved', 'provider_amount', 'providerAmount'),
      txDigest: response.digest,
    };
  }

  async arbitrate(params: {
    disputeId: string;
    taskId: string;
    rulingSplitMist: bigint;
    signer: Ed25519Keypair;
  }): Promise<{ txDigest: string }> {
    const tx = buildArbitrateDisputeTx({
      packageId: this.config.packageId,
      disputeId: params.disputeId,
      taskId: params.taskId,
      rulingSplitMist: params.rulingSplitMist,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async getDispute(disputeId: string): Promise<Dispute | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(disputeId);
      return parseDisputeFields(object, disputeId);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getDisputeByTask(taskId: string): Promise<Dispute | null> {
    const eventType = `${this.config.packageId}::dispute::DisputeOpened`;
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, 100);
      const matchedEvent = page.events.find((event) => asString(readEventField(normalizeEvent(event), 'task_id', 'taskId')) === taskId);
      if (matchedEvent) {
        const disputeId = asString(readEventField(normalizeEvent(matchedEvent), 'dispute_id', 'disputeId'));
        return disputeId ? await this.getDispute(disputeId) : null;
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return null;
  }
}

function extractObjectId(response: SuiTransactionBlockResponse, objectTypePattern: RegExp): string | undefined {
  const change = (response.objectChanges as Array<Record<string, unknown>> | null | undefined)?.find(
    (entry) =>
      (entry.type === 'created' || entry.type === 'transferred' || entry.type === 'mutated')
      && typeof entry.objectType === 'string'
      && objectTypePattern.test(entry.objectType)
      && typeof entry.objectId === 'string',
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

function isObjectMissingError(error: unknown): boolean {
  return error instanceof Error && /not found|does not contain move object data/i.test(error.message);
}
