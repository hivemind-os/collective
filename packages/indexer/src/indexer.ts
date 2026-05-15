import pino from 'pino';

import { MeshSuiClient, parseRawEvent } from '@agentic-mesh/core';
import type { Dispute, MeshEvent, ReputationAnchor } from '@agentic-mesh/types';
import { DisputeStatus, TaskStatus } from '@agentic-mesh/types';
import type { SuiEvent, SuiTransactionBlockResponse } from '@mysten/sui/client';

import type { IndexerStore } from './store.js';

const logger = pino({ name: '@agentic-mesh/indexer' });

const EVENT_NAMES = {
  agentRegistered: 'registry::AgentRegistered',
  agentUpdated: 'registry::AgentUpdated',
  agentDeactivated: 'registry::AgentDeactivated',
  taskPosted: 'task::TaskPosted',
  taskAccepted: 'task::TaskAccepted',
  taskCompleted: 'task::TaskCompleted',
  taskReleased: 'task::TaskPaymentReleased',
  taskDisputed: 'task::TaskDisputed',
  taskCancelled: 'task::TaskCancelled',
  taskExpiredRefunded: 'task::TaskExpiredRefunded',
  bidPlaced: 'marketplace::BidPlaced',
  bidAccepted: 'marketplace::BidAccepted',
  bidWithdrawn: 'marketplace::BidWithdrawn',
  bidRejected: 'marketplace::BidRejected',
  disputeOpened: 'dispute::DisputeOpened',
  disputeResponded: 'dispute::DisputeResponded',
  disputeMutuallyResolved: 'dispute::DisputeMutuallyResolved',
  disputeArbitrated: 'dispute::DisputeArbitrated',
  disputeExpired: 'dispute::DisputeExpired',
  stakeDeposited: 'staking::StakeDeposited',
  stakeWithdrawn: 'staking::StakeWithdrawn',
  stakeSlashed: 'staking::StakeSlashed',
  deactivationStarted: 'staking::DeactivationStarted',
  anchorPublished: 'reputation::AnchorPublished',
} as const;

export const SUPPORTED_EVENT_TYPES = Object.values(EVENT_NAMES);

interface TransactionMetadata {
  checkpoint?: number;
  gasCostMist: bigint;
}

interface ExtendedEventBase<TType extends string> {
  type: TType;
  txDigest: string;
  timestampMs: number;
}

interface DisputeOpenedEvent extends ExtendedEventBase<'dispute.opened'> {
  disputeId: string;
  dispute: Dispute;
}

interface DisputeUpdatedEvent extends ExtendedEventBase<'dispute.updated'> {
  disputeId: string;
  dispute?: Dispute;
  status: DisputeStatus;
  providerEvidenceBlob?: string;
  providerProposedSplit?: bigint;
  arbitrator?: string;
  rulingSplit?: bigint;
}

interface StakeDepositedEvent extends ExtendedEventBase<'stake.deposited'> {
  stakeId: string;
  owner: string;
  amountMist: bigint;
  stakeType?: 'agent' | 'relay';
}

interface StakeWithdrawnEvent extends ExtendedEventBase<'stake.withdrawn'> {
  stakeId: string;
  owner: string;
  amountMist: bigint;
}

interface StakeSlashedEvent extends ExtendedEventBase<'stake.slashed'> {
  stakeId: string;
  target: string;
  amountMist: bigint;
  taskId: string;
}

interface DeactivationStartedEvent extends ExtendedEventBase<'stake.deactivation_started'> {
  stakeId: string;
  owner: string;
  cooldownEndsAt: number;
}

interface AnchorPublishedEvent extends ExtendedEventBase<'reputation.anchor_published'> {
  anchor: ReputationAnchor;
}

type IndexedExtendedEvent =
  | DisputeOpenedEvent
  | DisputeUpdatedEvent
  | StakeDepositedEvent
  | StakeWithdrawnEvent
  | StakeSlashedEvent
  | DeactivationStartedEvent
  | AnchorPublishedEvent;

export interface MeshIndexerOptions {
  suiClient: MeshSuiClient;
  store: IndexerStore;
  packageId: string;
  pollIntervalMs?: number;
  startCheckpoint?: number;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export class MeshIndexer {
  private readonly logger: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  private readonly txMetadataCache = new Map<string, Promise<TransactionMetadata>>();

  private running = false;
  private timer?: NodeJS.Timeout;
  private pollLoopPromise?: Promise<void>;

  constructor(private readonly options: MeshIndexerOptions) {
    this.logger = options.logger ?? logger;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.pollLoopPromise = this.pollLoop().finally(() => {
      this.pollLoopPromise = undefined;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.pollLoopPromise?.catch(() => undefined);
  }

  isRunning(): boolean {
    return this.running;
  }

  async backfill(fromCheckpoint = this.options.startCheckpoint): Promise<number> {
    return await this.indexAllStreams(fromCheckpoint);
  }

  async pollOnce(): Promise<number> {
    return await this.indexAllStreams(this.options.startCheckpoint);
  }

  async processEvent(rawEvent: SuiEvent, metadata?: TransactionMetadata): Promise<void> {
    const txMetadata = metadata ?? (await this.getTransactionMetadata(rawEvent.id.txDigest));
    const wasInserted = this.options.store.recordEvent({
      eventId: formatEventId(rawEvent),
      eventType: rawEvent.type,
      packageId: this.options.packageId,
      txDigest: rawEvent.id.txDigest,
      timestampMs: readNumber(rawEvent.timestampMs),
      payload: normalizeMoveValue(rawEvent.parsedJson),
      checkpoint: txMetadata.checkpoint,
      module: rawEvent.transactionModule,
    });
    if (!wasInserted) {
      return;
    }

    const parsed = parseRawEvent(rawEvent, this.options.packageId);
    if (parsed) {
      this.handleParsedEvent(parsed, txMetadata);
      return;
    }

    const extended = await this.parseExtendedEvent(rawEvent);
    if (extended) {
      this.handleExtendedEvent(extended, txMetadata);
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.running) {
      return;
    }

    let nextDelay = this.options.pollIntervalMs ?? 5_000;
    try {
      const processed = await this.pollOnce();
      if (processed > 0) {
        nextDelay = 0;
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Indexer polling failed.');
    }

    if (this.running) {
      this.timer = setTimeout(() => {
        void this.pollLoop();
      }, nextDelay);
    }
  }

  private async indexAllStreams(fromCheckpoint?: number): Promise<number> {
    let processed = 0;
    for (const suffix of SUPPORTED_EVENT_TYPES) {
      processed += await this.indexEventType(`${this.options.packageId}::${suffix}`, fromCheckpoint);
    }
    return processed;
  }

  private async indexEventType(eventType: string, fromCheckpoint?: number): Promise<number> {
    const cursorKey = `event:${eventType}`;
    let cursor = this.options.store.getCursor(cursorKey);
    let processed = 0;

    while (true) {
      const page = await this.options.suiClient.queryEvents(eventType, cursor, 100);
      for (const event of page.events) {
        const metadata = await this.getTransactionMetadata(event.id.txDigest);
        if (typeof fromCheckpoint === 'number' && typeof metadata.checkpoint === 'number' && metadata.checkpoint < fromCheckpoint) {
          cursor = event.id;
          this.options.store.setCursor(cursorKey, event.id);
          continue;
        }

        await this.processEvent(event, metadata);
        cursor = event.id;
        this.options.store.setCursor(cursorKey, event.id);
        processed += 1;
      }

      if (!page.hasMore || !page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    return processed;
  }

  private handleParsedEvent(event: MeshEvent, metadata: TransactionMetadata): void {
    switch (event.type) {
      case 'agent.registered':
      case 'agent.updated':
        this.options.store.upsertAgent(event.agent);
        break;
      case 'agent.deactivated':
        this.options.store.markAgentInactive(event.agentId);
        break;
      case 'task.posted':
        this.options.store.upsertTask(event.task, event.txDigest, metadata.gasCostMist);
        break;
      case 'task.accepted':
        this.options.store.updateTaskStatus({
          taskId: event.taskId,
          status: event.status,
          txDigest: event.txDigest,
          timestampMs: event.acceptedAt,
          provider: event.provider,
          requester: event.requester,
          price: event.price,
          gasCostMist: metadata.gasCostMist,
          eventType: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        break;
      case 'task.completed':
        this.options.store.updateTaskStatus({
          taskId: event.taskId,
          status: event.status,
          txDigest: event.txDigest,
          timestampMs: event.completedAt,
          provider: event.provider,
          resultBlobId: event.resultBlobId,
          price: event.price,
          paymentScheme: event.paymentScheme,
          meteredUnits: event.meteredUnits,
          verificationHash: event.verificationHash,
          gasCostMist: metadata.gasCostMist,
          eventType: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        break;
      case 'task.released':
        this.options.store.updateTaskStatus({
          taskId: event.taskId,
          status: event.status,
          txDigest: event.txDigest,
          timestampMs: event.releasedAt,
          provider: event.provider,
          requester: event.requester,
          price: event.price,
          gasCostMist: metadata.gasCostMist,
          eventType: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        break;
      case 'task.disputed':
        this.options.store.updateTaskStatus({
          taskId: event.taskId,
          status: event.status,
          txDigest: event.txDigest,
          timestampMs: event.disputedAt,
          provider: event.provider,
          requester: event.requester,
          gasCostMist: metadata.gasCostMist,
          eventType: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        break;
      case 'task.cancelled':
        this.options.store.updateTaskStatus({
          taskId: event.taskId,
          status: event.status,
          txDigest: event.txDigest,
          timestampMs: event.cancelledAt,
          requester: event.requester,
          gasCostMist: metadata.gasCostMist,
          eventType: event.type,
          payload: event as unknown as Record<string, unknown>,
        });
        break;
      case 'bid.placed':
        this.options.store.upsertBid(event.bid);
        break;
      case 'bid.accepted':
        this.options.store.updateBidStatus(event.bidId, event.status, event.acceptedAt);
        break;
      case 'bid.withdrawn':
        this.options.store.updateBidStatus(event.bidId, event.status, event.withdrawnAt);
        break;
      case 'bid.rejected':
        this.options.store.updateBidStatus(event.bidId, event.status, event.rejectedAt);
        break;
      default:
        break;
    }
  }

  private handleExtendedEvent(event: IndexedExtendedEvent, metadata: TransactionMetadata): void {
    switch (event.type) {
      case 'dispute.opened':
        this.options.store.upsertDispute(event.dispute);
        break;
      case 'dispute.updated': {
        const dispute = event.dispute;
        if (dispute) {
          this.options.store.upsertDispute(dispute);
        } else {
          this.options.store.updateDispute({
            disputeId: event.disputeId,
            status: event.status,
            respondedAt: event.status === DisputeStatus.RESPONDED ? event.timestampMs : undefined,
            resolvedAt: event.status !== DisputeStatus.RESPONDED ? event.timestampMs : undefined,
            providerEvidenceBlob: event.providerEvidenceBlob,
            providerProposedSplit: event.providerProposedSplit,
            arbitrator: event.arbitrator,
            rulingSplit: event.rulingSplit,
          });
        }
        if (event.status !== DisputeStatus.RESPONDED) {
          const taskId = dispute?.taskId;
          if (taskId) {
            this.options.store.updateTaskStatus({
              taskId,
              status: TaskStatus.RELEASED,
              txDigest: event.txDigest,
              timestampMs: event.timestampMs,
              requester: dispute.requester,
              provider: dispute.provider,
              gasCostMist: metadata.gasCostMist,
              eventType: `task.released_after_${event.type}`,
              payload: event as unknown as Record<string, unknown>,
            });
          }
        }
        break;
      }
      case 'stake.deposited':
        this.options.store.upsertStake({
          stakeId: event.stakeId,
          owner: event.owner,
          amountMist: event.amountMist,
          stakeType: event.stakeType,
          stakedAt: event.timestampMs,
          active: true,
        });
        break;
      case 'stake.withdrawn':
        this.options.store.upsertStake({
          stakeId: event.stakeId,
          owner: event.owner,
          amountMist: 0n,
          withdrawnAt: event.timestampMs,
          active: false,
        });
        break;
      case 'stake.slashed':
        this.options.store.addStakeSlash(event.stakeId, event.amountMist);
        break;
      case 'stake.deactivation_started':
        this.options.store.upsertStake({
          stakeId: event.stakeId,
          owner: event.owner,
          deactivatedAt: event.timestampMs,
          active: false,
        });
        break;
      case 'reputation.anchor_published':
        this.options.store.upsertReputationAnchor({
          anchorId: event.anchor.anchorId,
          author: event.anchor.author,
          merkleRoot: event.anchor.merkleRoot,
          eventCount: event.anchor.eventCount,
          blobId: event.anchor.blobId,
          fromTimestamp: event.anchor.fromTimestamp,
          toTimestamp: event.anchor.toTimestamp,
          createdAt: event.timestampMs,
          txDigest: event.txDigest,
        });
        break;
      default:
        break;
    }
  }

  private async parseExtendedEvent(rawEvent: SuiEvent): Promise<IndexedExtendedEvent | null> {
    const payload = toRecord(normalizeMoveValue(rawEvent.parsedJson)) ?? {};
    const base = {
      txDigest: rawEvent.id.txDigest,
      timestampMs: readNumber(rawEvent.timestampMs),
    };

    switch (rawEvent.type) {
      case `${this.options.packageId}::${EVENT_NAMES.disputeOpened}`: {
        const disputeId = readString(payload.dispute_id, payload.disputeId);
        const dispute = (await this.fetchDispute(disputeId)) ?? buildFallbackDispute(payload, disputeId, base.timestampMs);
        return { ...base, type: 'dispute.opened', disputeId, dispute };
      }
      case `${this.options.packageId}::${EVENT_NAMES.disputeResponded}`: {
        const disputeId = readString(payload.dispute_id, payload.disputeId);
        return {
          ...base,
          type: 'dispute.updated',
          disputeId,
          dispute: await this.fetchDispute(disputeId),
          status: DisputeStatus.RESPONDED,
          providerEvidenceBlob: readBytes(payload.provider_evidence_blob, payload.providerEvidenceBlob),
        };
      }
      case `${this.options.packageId}::${EVENT_NAMES.disputeMutuallyResolved}`: {
        const disputeId = readString(payload.dispute_id, payload.disputeId);
        return {
          ...base,
          type: 'dispute.updated',
          disputeId,
          dispute: await this.fetchDispute(disputeId),
          status: DisputeStatus.MUTUAL_RESOLVED,
          rulingSplit: readBigInt(payload.provider_amount, payload.providerAmount),
        };
      }
      case `${this.options.packageId}::${EVENT_NAMES.disputeArbitrated}`: {
        const disputeId = readString(payload.dispute_id, payload.disputeId);
        return {
          ...base,
          type: 'dispute.updated',
          disputeId,
          dispute: await this.fetchDispute(disputeId),
          status: DisputeStatus.ARBITRATED,
          arbitrator: readString(payload.arbitrator),
          rulingSplit: readBigInt(payload.provider_amount, payload.providerAmount),
        };
      }
      case `${this.options.packageId}::${EVENT_NAMES.disputeExpired}`: {
        const disputeId = readString(payload.dispute_id, payload.disputeId);
        return {
          ...base,
          type: 'dispute.updated',
          disputeId,
          dispute: await this.fetchDispute(disputeId),
          status: DisputeStatus.EXPIRED,
        };
      }
      case `${this.options.packageId}::${EVENT_NAMES.stakeDeposited}`:
        return {
          ...base,
          type: 'stake.deposited',
          stakeId: readString(payload.stake_id, payload.stakeId),
          owner: readString(payload.owner),
          amountMist: readBigInt(payload.amount),
          stakeType: normalizeStakeType(payload.stake_type, payload.stakeType),
        };
      case `${this.options.packageId}::${EVENT_NAMES.stakeWithdrawn}`:
        return {
          ...base,
          type: 'stake.withdrawn',
          stakeId: readString(payload.stake_id, payload.stakeId),
          owner: readString(payload.owner),
          amountMist: readBigInt(payload.amount),
        };
      case `${this.options.packageId}::${EVENT_NAMES.stakeSlashed}`:
        return {
          ...base,
          type: 'stake.slashed',
          stakeId: readString(payload.stake_id, payload.stakeId),
          target: readString(payload.target),
          amountMist: readBigInt(payload.amount),
          taskId: readString(payload.task_id, payload.taskId),
        };
      case `${this.options.packageId}::${EVENT_NAMES.deactivationStarted}`:
        return {
          ...base,
          type: 'stake.deactivation_started',
          stakeId: readString(payload.stake_id, payload.stakeId),
          owner: readString(payload.owner),
          cooldownEndsAt: readNumber(payload.cooldown_ends_at, payload.cooldownEndsAt),
        };
      case `${this.options.packageId}::${EVENT_NAMES.anchorPublished}`: {
        const anchorId = readString(payload.anchor_id, payload.anchorId);
        const anchor = (await this.fetchAnchor(anchorId)) ?? {
          anchorId,
          author: readString(payload.author),
          merkleRoot: readHex(payload.merkle_root, payload.merkleRoot),
          eventCount: readNumber(payload.event_count, payload.eventCount),
          blobId: '',
          fromTimestamp: 0,
          toTimestamp: 0,
        };
        return { ...base, type: 'reputation.anchor_published', anchor };
      }
      default:
        return null;
    }
  }

  private async getTransactionMetadata(txDigest: string): Promise<TransactionMetadata> {
    const cached = this.txMetadataCache.get(txDigest);
    if (cached) {
      return await cached;
    }

    const pending = this.loadTransactionMetadata(txDigest);
    this.txMetadataCache.set(txDigest, pending);
    pending.finally(() => {
      if (this.txMetadataCache.get(txDigest) === pending) {
        this.txMetadataCache.delete(txDigest);
      }
    });
    return await pending;
  }

  private async loadTransactionMetadata(txDigest: string): Promise<TransactionMetadata> {
    try {
      const response = await this.options.suiClient.client.getTransactionBlock({
        digest: txDigest,
        options: { showEffects: true },
      });
      return {
        checkpoint: response.checkpoint == null ? undefined : Number(response.checkpoint),
        gasCostMist: computeGasCost(response),
      };
    } catch (error) {
      this.logger.warn({ err: error, txDigest }, 'Failed to load transaction metadata.');
      return { gasCostMist: 0n };
    }
  }

  private async fetchDispute(disputeId: string): Promise<Dispute | undefined> {
    if (!disputeId) {
      return undefined;
    }
    try {
      const object = await this.options.suiClient.getObject<Record<string, unknown>>(disputeId);
      return parseDisputeObject(object, disputeId);
    } catch {
      return undefined;
    }
  }

  private async fetchAnchor(anchorId: string): Promise<ReputationAnchor | undefined> {
    if (!anchorId) {
      return undefined;
    }
    try {
      const object = await this.options.suiClient.getObject<Record<string, unknown>>(anchorId);
      return {
        anchorId,
        author: readString(object.author),
        merkleRoot: readHex(object.merkle_root, object.merkleRoot),
        eventCount: readNumber(object.event_count, object.eventCount),
        blobId: readBytes(object.blob_id, object.blobId),
        fromTimestamp: readNumber(object.from_timestamp, object.fromTimestamp),
        toTimestamp: readNumber(object.to_timestamp, object.toTimestamp),
      };
    } catch {
      return undefined;
    }
  }
}

function buildFallbackDispute(payload: Record<string, unknown>, disputeId: string, timestampMs: number): Dispute {
  return {
    id: disputeId,
    taskId: readString(payload.task_id, payload.taskId),
    requester: readString(payload.requester),
    provider: readString(payload.provider),
    escrowAmount: readBigInt(payload.escrow_amount, payload.escrowAmount),
    status: DisputeStatus.OPEN,
    requesterEvidenceBlob: '',
    providerEvidenceBlob: undefined,
    requesterProposedSplit: 0n,
    providerProposedSplit: 0n,
    arbitrator: undefined,
    rulingSplit: 0n,
    openedAt: timestampMs,
    respondedAt: undefined,
    resolvedAt: undefined,
    resolutionDeadline: timestampMs,
  };
}

function parseDisputeObject(object: Record<string, unknown>, disputeId: string): Dispute {
  const respondedAt = readNumber(object.responded_at, object.respondedAt);
  const resolvedAt = readNumber(object.resolved_at, object.resolvedAt);
  return {
    id: disputeId,
    taskId: readString(object.task_id, object.taskId),
    requester: readString(object.requester),
    provider: readString(object.provider),
    escrowAmount: readBigInt(object.escrow_amount, object.escrowAmount),
    status: readNumber(object.status) as DisputeStatus,
    requesterEvidenceBlob: readBytes(object.requester_evidence_blob, object.requesterEvidenceBlob),
    providerEvidenceBlob: readBytes(object.provider_evidence_blob, object.providerEvidenceBlob) || undefined,
    requesterProposedSplit: readBigInt(object.requester_proposed_split, object.requesterProposedSplit),
    providerProposedSplit: readBigInt(object.provider_proposed_split, object.providerProposedSplit),
    arbitrator: readString(object.arbitrator) || undefined,
    rulingSplit: readBigInt(object.ruling_split, object.rulingSplit),
    openedAt: readNumber(object.opened_at, object.openedAt),
    respondedAt: respondedAt > 0 ? respondedAt : undefined,
    resolvedAt: resolvedAt > 0 ? resolvedAt : undefined,
    resolutionDeadline: readNumber(object.resolution_deadline, object.resolutionDeadline),
  };
}

function formatEventId(event: SuiEvent): string {
  return `${event.id.txDigest}:${event.id.eventSeq}`;
}

function computeGasCost(response: SuiTransactionBlockResponse): bigint {
  const gasUsed = response.effects?.gasUsed;
  if (!gasUsed) {
    return 0n;
  }
  const computationCost = readBigInt(gasUsed.computationCost);
  const storageCost = readBigInt(gasUsed.storageCost);
  const storageRebate = readBigInt(gasUsed.storageRebate);
  const nonRefundable = readBigInt(gasUsed.nonRefundableStorageFee);
  const total = computationCost + storageCost + nonRefundable - storageRebate;
  return total > 0n ? total : 0n;
}

function normalizeMoveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMoveValue(entry));
  }
  if (!toRecord(value)) {
    return value;
  }
  if (typeof (value as { id?: unknown }).id === 'string' && Object.keys(value as Record<string, unknown>).length === 1) {
    return (value as { id: string }).id;
  }
  if (toRecord((value as { fields?: unknown }).fields)) {
    return normalizeMoveValue((value as { fields: unknown }).fields);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeMoveValue(entry)]),
  );
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(...values: unknown[]): string {
  const match = values.find((value) => typeof value === 'string');
  return typeof match === 'string' ? match : '';
}

function readBytes(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
    if (value instanceof Uint8Array) {
      return new TextDecoder().decode(value);
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
      return new TextDecoder().decode(new Uint8Array(value));
    }
  }
  return '';
}

function readHex(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && /^[a-f0-9]+$/i.test(value)) {
      return value;
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('hex');
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
      return Buffer.from(value).toString('hex');
    }
  }
  return '';
}

function readNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.length > 0) {
      return Number(value);
    }
  }
  return 0;
}

function readBigInt(...values: unknown[]): bigint {
  for (const value of values) {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number') {
      return BigInt(value);
    }
    if (typeof value === 'string' && value.length > 0) {
      return BigInt(value);
    }
  }
  return 0n;
}

function normalizeStakeType(...values: unknown[]): 'agent' | 'relay' | undefined {
  const value = values.find((entry) => entry !== undefined);
  if (value === 'agent' || value === 0 || value === '0') {
    return 'agent';
  }
  if (value === 'relay' || value === 1 || value === '1') {
    return 'relay';
  }
  return undefined;
}

