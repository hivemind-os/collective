import pino from 'pino';

import type { NetworkConfig, Task } from '@hivemind-os/collective-types';
import type { Signer } from '@mysten/sui/cryptography';

import { parseTaskFields } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildAcceptTaskTx,
  buildCancelTaskTx,
  buildClaimPaymentTx,
  buildCompleteMeteredTaskTx,
  buildCompleteTaskTx,
  buildPostMeteredTaskTx,
  buildPostTaskTx,
  buildRefundExpiredTaskTx,
  buildReleaseMeteredPaymentTx,
  buildReleasePaymentTx,
} from '../sui/tx-helpers.js';

const logger = pino({ name: '@hivemind-os/collective-core:task' });

export class TaskClient {
  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: NetworkConfig,
  ) {}

  async postTask(params: {
    capability: string;
    category: string;
    inputBlobId: string;
    agreementHash?: string;
    priceMist: bigint;
    disputeWindowMs: number;
    expiryHours: number;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string; taskId: string }> {
    const tx = buildPostTaskTx({
      packageId: this.config.packageId,
      capability: params.capability,
      category: params.category,
      inputBlobId: params.inputBlobId,
      agreementHash: params.agreementHash,
      priceMist: params.priceMist,
      disputeWindowMs: params.disputeWindowMs,
      expiryHours: params.expiryHours,
      coinType: params.coinType,
    });

    return await this.submitTaskCreation(tx, params.keypair);
  }

  async postMeteredTask(params: {
    capability: string;
    category: string;
    inputBlobId: string;
    agreementHash?: string;
    maxPriceMist: bigint;
    unitPriceMist: bigint;
    disputeWindowMs: number;
    expiryHours: number;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string; taskId: string }> {
    const tx = buildPostMeteredTaskTx({
      packageId: this.config.packageId,
      capability: params.capability,
      category: params.category,
      inputBlobId: params.inputBlobId,
      agreementHash: params.agreementHash,
      maxPriceMist: params.maxPriceMist,
      unitPriceMist: params.unitPriceMist,
      disputeWindowMs: params.disputeWindowMs,
      expiryHours: params.expiryHours,
      coinType: params.coinType,
    });

    return await this.submitTaskCreation(tx, params.keypair);
  }

  async acceptTask(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildAcceptTaskTx({ packageId: this.config.packageId, taskId: params.taskId, coinType: params.coinType });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async completeTask(params: {
    taskId: string;
    resultBlobId: string;
    coinType?: string;
    keypair: Signer;
    providerCardId?: string;
  }): Promise<{ txDigest: string }> {
    const tx = buildCompleteTaskTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      resultBlobId: params.resultBlobId,
      coinType: params.coinType,
      providerCardId: params.providerCardId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async completeMeteredTask(params: {
    taskId: string;
    resultBlobId: string;
    meteredUnits: number;
    verificationHash: string;
    coinType?: string;
    keypair: Signer;
    providerCardId?: string;
  }): Promise<{ txDigest: string }> {
    const tx = buildCompleteMeteredTaskTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      resultBlobId: params.resultBlobId,
      meteredUnits: params.meteredUnits,
      verificationHash: params.verificationHash,
      coinType: params.coinType,
      providerCardId: params.providerCardId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async releasePayment(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildReleasePaymentTx({ packageId: this.config.packageId, taskId: params.taskId, coinType: params.coinType });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async releaseMeteredPayment(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildReleaseMeteredPaymentTx({ packageId: this.config.packageId, taskId: params.taskId, coinType: params.coinType });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async claimPayment(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
    providerCardId?: string;
  }): Promise<{ txDigest: string }> {
    const tx = buildClaimPaymentTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      coinType: params.coinType,
      providerCardId: params.providerCardId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async cancelTask(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildCancelTaskTx({ packageId: this.config.packageId, taskId: params.taskId, coinType: params.coinType });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async refundExpiredTask(params: {
    taskId: string;
    coinType?: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildRefundExpiredTaskTx({ packageId: this.config.packageId, taskId: params.taskId, coinType: params.coinType });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(taskId);
      return parseTaskFields(object, taskId);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async submitTaskCreation(tx: ReturnType<typeof buildPostTaskTx>, keypair: Signer): Promise<{ txDigest: string; taskId: string }> {
    const response = await this.suiClient.executeTransaction(tx, keypair);
    const taskId = extractObjectId(response.objectChanges, /::task::Task$/);

    if (!taskId) {
      logger.warn({ response }, 'Task posting succeeded without a Task object change.');
      throw new Error('Unable to determine task id from transaction response.');
    }

    return { txDigest: response.digest, taskId };
  }
}

function extractObjectId(
  objectChanges: Array<Record<string, unknown>> | null | undefined,
  objectTypePattern: RegExp,
): string | undefined {
  return objectChanges?.find(
    (change) =>
      (change.type === 'created' || change.type === 'mutated') &&
      typeof change.objectType === 'string' &&
      objectTypePattern.test(change.objectType) &&
      typeof change.objectId === 'string',
  )?.objectId as string | undefined;
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

  if (error instanceof Error) {
    return /could not find.*object|object.*not found|does not exist|no data.*objectId|dynamicFieldNotFound|does not contain move object data/i.test(error.message);
  }

  return false;
}
