import pino from 'pino';

import type { Bid, BidRecommendation, NetworkConfig, Task } from '@hivemind-os/collective-types';
import { BidStatus, TaskStatus } from '@hivemind-os/collective-types';
import type { SuiEvent, SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';

import { isRecord, normalizeMoveValue, parseBidFields, parseTaskFields } from '../internal/parsing.js';
import { ReputationScoreCalculator } from '../reputation/score-calculator.js';
import { RegistryClient } from '../registry/client.js';
import { MeshSuiClient } from '../sui/client.js';
import { buildAcceptBidTx, buildPlaceBidTx, buildRejectBidTx, buildWithdrawBidTx } from '../sui/tx-helpers.js';
import { TaskClient } from '../task/client.js';

const logger = pino({ name: '@hivemind-os/collective-core:marketplace' });
const DEFAULT_REPUTATION_WEIGHT = 1_000_000n;
const DEFAULT_PRICE_WEIGHT = 1n;
const DEFAULT_BROWSE_LIMIT = 20;
const SCORE_SCALE = 1_000_000n;

export interface BrowseOpenTasksFilters {
  category?: string;
  minPriceMist?: bigint;
  maxPriceMist?: bigint;
  limit?: number;
}

export class MarketplaceClient {
  private readonly taskClient: TaskClient;
  private readonly registryClient: RegistryClient;
  private readonly scoreCalculator = new ReputationScoreCalculator();

  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: NetworkConfig,
  ) {
    this.taskClient = new TaskClient(suiClient, config);
    this.registryClient = new RegistryClient(suiClient, config);
  }

  async postOpenTask(params: {
    capability: string;
    category: string;
    inputBlobId: string;
    agreementHash?: string;
    priceMist: bigint;
    disputeWindowMs: number;
    expiryHours: number;
    signer: Signer;
  }): Promise<{ txDigest: string; taskId: string }> {
    return await this.taskClient.postTask({
      capability: params.capability,
      category: params.category,
      inputBlobId: params.inputBlobId,
      agreementHash: params.agreementHash,
      priceMist: params.priceMist,
      disputeWindowMs: params.disputeWindowMs,
      expiryHours: params.expiryHours,
      keypair: params.signer,
    });
  }

  async placeBid(params: {
    taskId: string;
    bidPriceMist: bigint;
    signer: Signer;
    reputationScore?: bigint | number;
    evidenceBlob?: string;
  }): Promise<{ bidId: string; txDigest: string; reputationScore: bigint }> {
    const reputationScore = params.reputationScore == null
      ? await this.deriveReputationScore(params.signer.getPublicKey().toSuiAddress())
      : toNonNegativeBigInt(params.reputationScore, 'params.reputationScore');

    const tx = buildPlaceBidTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      bidPriceMist: params.bidPriceMist,
      reputationScore,
      evidenceBlob: params.evidenceBlob,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    const bidId = extractObjectId(response, /::marketplace::Bid$/);
    if (!bidId) {
      logger.warn({ response }, 'Bid placement succeeded without a Bid object change.');
      throw new Error('Unable to determine bid id from transaction response.');
    }

    return { bidId, txDigest: response.digest, reputationScore };
  }

  async acceptBid(params: {
    taskId: string;
    bidId: string;
    signer: Signer;
    rejectCompeting?: boolean;
  }): Promise<{ txDigest: string; rejectedBidIds: string[] }> {
    const rejectedBidIds = params.rejectCompeting === false
      ? []
      : (await this.getBidsForTask(params.taskId))
        .filter((bid) => bid.id !== params.bidId && bid.status === BidStatus.ACTIVE)
        .map((bid) => bid.id);

    const tx = buildAcceptBidTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      bidId: params.bidId,
      otherBidIds: rejectedBidIds,
    });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest, rejectedBidIds };
  }

  async withdrawBid(params: { bidId: string; signer: Signer }): Promise<{ txDigest: string }> {
    const tx = buildWithdrawBidTx({ packageId: this.config.packageId, bidId: params.bidId });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async rejectBid(params: { taskId: string; bidId: string; signer: Signer }): Promise<{ txDigest: string }> {
    const tx = buildRejectBidTx({ packageId: this.config.packageId, taskId: params.taskId, bidId: params.bidId });
    const response = await this.suiClient.executeTransaction(tx, params.signer);
    return { txDigest: response.digest };
  }

  async getBid(bidId: string): Promise<Bid | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(bidId);
      return parseBidFields(object, bidId);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getBidsForTask(taskId: string): Promise<Bid[]> {
    const eventType = `${this.config.packageId}::marketplace::BidPlaced`;
    const bidIds = new Set<string>();
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, 100);
      for (const event of page.events) {
        const payload = normalizeEvent(event);
        if (asString(readField(payload, 'task_id', 'taskId')) !== taskId) {
          continue;
        }
        const bidId = asString(readField(payload, 'bid_id', 'bidId'));
        if (bidId) {
          bidIds.add(bidId);
        }
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    const bids = await Promise.all([...bidIds].map(async (bidId) => await this.getBid(bidId)));
    return bids
      .filter((bid): bid is Bid => Boolean(bid))
      .sort((left, right) => left.createdAt - right.createdAt || compareBigInt(left.bidPrice, right.bidPrice));
  }

  async browseOpenTasks(filters: BrowseOpenTasksFilters = {}): Promise<Task[]> {
    const eventType = `${this.config.packageId}::task::TaskPosted`;
    const limit = normalizeLimit(filters.limit, DEFAULT_BROWSE_LIMIT, 'filters.limit');
    const category = normalizeOptionalCategory(filters.category);
    if (filters.minPriceMist != null && filters.maxPriceMist != null && filters.minPriceMist > filters.maxPriceMist) {
      throw new Error('filters.minPriceMist must be less than or equal to filters.maxPriceMist.');
    }
    const taskIds = new Set<string>();
    const tasks: Task[] = [];
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, Math.max(limit * 3, 20));
      const pageTaskIds = new Set<string>();
      const postedTasks = page.events
        .map((event) => parseTaskFields(normalizeEvent(event)))
        .filter((task) => {
          if (!task.id || taskIds.has(task.id) || pageTaskIds.has(task.id)) {
            return false;
          }
          pageTaskIds.add(task.id);
          return true;
        })
        .filter((task) => !category || task.category.toLowerCase() === category.toLowerCase());
      const fetchedTasks = await Promise.all(postedTasks.map(async (task) => await this.taskClient.getTask(task.id)));
      const validTasks = fetchedTasks.filter((task): task is Task => {
        if (!task || !isTaskBrowseable(task) || Date.now() >= task.expiresAt) {
          return false;
        }
        if (category && task.category.toLowerCase() !== category.toLowerCase()) {
          return false;
        }
        if (filters.minPriceMist != null && task.price < filters.minPriceMist) {
          return false;
        }
        if (filters.maxPriceMist != null && task.price > filters.maxPriceMist) {
          return false;
        }
        return true;
      });

      for (const task of validTasks) {
        taskIds.add(task.id);
        tasks.push(task);
        if (tasks.length >= limit) {
          return tasks.sort((left, right) => right.createdAt - left.createdAt);
        }
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return tasks.sort((left, right) => right.createdAt - left.createdAt);
  }

  async getRecommendedBid(
    taskId: string,
    options: { reputationWeight?: bigint | number; priceWeight?: bigint | number } = {},
  ): Promise<BidRecommendation | null> {
    const bids = (await this.getBidsForTask(taskId)).filter((bid) => bid.status === BidStatus.ACTIVE);
    if (bids.length === 0) {
      return null;
    }

    const reputationWeight = options.reputationWeight == null
      ? DEFAULT_REPUTATION_WEIGHT
      : toNonNegativeBigInt(options.reputationWeight, 'options.reputationWeight');
    const priceWeight = options.priceWeight == null
      ? DEFAULT_PRICE_WEIGHT
      : toNonNegativeBigInt(options.priceWeight, 'options.priceWeight');
    const ranked = bids
      .map((bid) => ({
        bid,
        score: calculateBidSelectionScore(bid.reputationScore, bid.bidPrice, reputationWeight, priceWeight),
        reputationWeight,
        priceWeight,
      }))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return left.score > right.score ? -1 : 1;
        }
        return compareBigInt(left.bid.bidPrice, right.bid.bidPrice) || left.bid.createdAt - right.bid.createdAt;
      });

    return ranked[0] ?? null;
  }

  private async deriveReputationScore(owner: string): Promise<bigint> {
    const card = await this.registryClient.getAgentCardByOwner(owner);
    if (!card) {
      return 0n;
    }

    const score = this.scoreCalculator.computeScore(card, []);
    const stakeBonus = score.stakeAmount / 1_000_000_000n;
    const boundedStakeBonus = stakeBonus > 10_000n ? 10_000n : stakeBonus;
    const reputationScore = Math.max(
      Math.round(score.successRate * 1_000) + (score.totalTasks * 10) - (score.totalDisputes * 25),
      0,
    );
    return BigInt(reputationScore) + boundedStakeBonus;
  }
}

function calculateBidSelectionScore(
  reputationScore: bigint,
  bidPrice: bigint,
  reputationWeight: bigint,
  priceWeight: bigint,
): bigint {
  return (reputationScore * reputationWeight * SCORE_SCALE) / ((bidPrice * priceWeight) + 1n);
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

function normalizeEvent(event: SuiEvent): Record<string, unknown> {
  const normalized = normalizeMoveValue(event.parsedJson);
  return isRecord(normalized) ? normalized : {};
}

function readField(record: Record<string, unknown>, ...keys: string[]): unknown {
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

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function toNonNegativeBigInt(value: bigint | number, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error(`${field} must be non-negative.`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return BigInt(value);
}

function normalizeLimit(value: number | undefined, fallback: number, field: string): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function normalizeOptionalCategory(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('filters.category must be a non-empty string when provided.');
  }
  return trimmed;
}

function isTaskBrowseable(task: Task): boolean {
  const status = task.status as Task['status'] | 'open' | 'posted';
  return status === TaskStatus.OPEN || status === 'open' || status === 'posted';
}

function isObjectMissingError(error: unknown): boolean {
  return error instanceof Error && /not found|does not contain move object data/i.test(error.message);
}
