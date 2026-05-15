import pino from 'pino';

import type { NetworkConfig, Task } from '@agentic-mesh/types';
import type { Signer } from '@mysten/sui/cryptography';

import { parseTaskFields } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildAcceptTaskTx,
  buildCancelTaskTx,
  buildClaimPaymentTx,
  buildCompleteTaskTx,
  buildPostTaskTx,
  buildRefundExpiredTaskTx,
  buildReleasePaymentTx,
} from '../sui/tx-helpers.js';

const logger = pino({ name: '@agentic-mesh/core:task' });

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
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    const taskId = extractObjectId(response.objectChanges, /::task::Task$/);

    if (!taskId) {
      logger.warn({ response }, 'Task posting succeeded without a Task object change.');
      throw new Error('Unable to determine task id from transaction response.');
    }

    return { txDigest: response.digest, taskId };
  }

  async acceptTask(params: {
    taskId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildAcceptTaskTx({ packageId: this.config.packageId, taskId: params.taskId });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async completeTask(params: {
    taskId: string;
    resultBlobId: string;
    keypair: Signer;
    providerCardId?: string;
  }): Promise<{ txDigest: string }> {
    const tx = buildCompleteTaskTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      resultBlobId: params.resultBlobId,
      providerCardId: params.providerCardId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async releasePayment(params: {
    taskId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildReleasePaymentTx({ packageId: this.config.packageId, taskId: params.taskId });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async claimPayment(params: {
    taskId: string;
    keypair: Signer;
    providerCardId?: string;
  }): Promise<{ txDigest: string }> {
    const tx = buildClaimPaymentTx({
      packageId: this.config.packageId,
      taskId: params.taskId,
      providerCardId: params.providerCardId,
    });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async cancelTask(params: {
    taskId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildCancelTaskTx({ packageId: this.config.packageId, taskId: params.taskId });
    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async refundExpiredTask(params: {
    taskId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildRefundExpiredTaskTx({ packageId: this.config.packageId, taskId: params.taskId });
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
  return error instanceof Error && /not found|does not contain move object data/i.test(error.message);
}
