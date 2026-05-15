import pino from 'pino';

import type { NetworkConfig } from '@agentic-mesh/types';
import {
  SuiClient,
  type EventId as EventID,
  type SuiEvent,
  type SuiTransactionBlockResponse,
  type SuiTransactionBlockResponseOptions,
} from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { isRecord, normalizeMoveValue, normalizeObjectOwner } from '../internal/parsing.js';

const logger = pino({ name: '@agentic-mesh/core:sui' });
const MAX_TRANSACTION_ATTEMPTS = 3;

export interface ExecuteTransactionOptions {
  requestType?: 'WaitForEffectsCert' | 'WaitForLocalExecution';
  responseOptions?: SuiTransactionBlockResponseOptions;
  timeout?: number;
  pollInterval?: number;
}

export class SuiTransactionExecutionError extends Error {
  readonly digest?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { cause?: unknown; digest?: string; retryable?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SuiTransactionExecutionError';
    this.digest = options.digest;
    this.retryable = options.retryable ?? false;
  }
}

export function createSuiClient(config: NetworkConfig): SuiClient {
  return new SuiClient({ url: config.rpcUrl });
}

export class MeshSuiClient {
  private readonly suiClient: SuiClient;

  constructor(private readonly networkConfig: NetworkConfig) {
    this.suiClient = createSuiClient(networkConfig);
  }

  async executeTransaction(
    tx: Transaction,
    keypair: Signer,
    options: ExecuteTransactionOptions = {},
  ): Promise<SuiTransactionBlockResponse> {
    const responseOptions: SuiTransactionBlockResponseOptions = {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
      ...options.responseOptions,
    };

    tx.setSenderIfNotSet(keypair.getPublicKey().toSuiAddress());

    let lastError: SuiTransactionExecutionError | undefined;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        const executed = await this.suiClient.signAndExecuteTransaction({
          transaction: tx,
          signer: keypair,
          requestType: options.requestType ?? 'WaitForLocalExecution',
          options: responseOptions,
        });
        const response = await this.suiClient.waitForTransaction({
          digest: executed.digest,
          options: responseOptions,
          timeout: options.timeout,
          pollInterval: options.pollInterval,
        });
        const failure = getExecutionFailure(response);
        if (failure) {
          throw failure;
        }

        return response;
      } catch (error) {
        const executionError = normalizeExecutionError(error);
        lastError = executionError;
        if (attempt >= MAX_TRANSACTION_ATTEMPTS || !executionError.retryable) {
          throw executionError;
        }

        logger.warn(
          { err: executionError, attempt, digest: executionError.digest },
          'Retrying Sui transaction after retryable failure.',
        );
        await delay(getRetryDelayMs(attempt));
      }
    }

    throw lastError ?? new SuiTransactionExecutionError('Transaction execution failed.');
  }

  async getBalance(address: string): Promise<bigint> {
    const balance = await this.suiClient.getBalance({ owner: address });
    return BigInt(balance.totalBalance);
  }

  async queryEvents(
    eventType: string,
    cursor?: EventID | null,
    limit?: number,
  ): Promise<{ events: SuiEvent[]; nextCursor: EventID | null; hasMore: boolean }> {
    const result = await this.suiClient.queryEvents({
      query: { MoveEventType: eventType },
      cursor: cursor ?? undefined,
      limit,
      order: 'ascending',
    });

    return {
      events: result.data,
      nextCursor: result.nextCursor ?? null,
      hasMore: result.hasNextPage,
    };
  }

  async getObject<T>(objectId: string): Promise<T> {
    const response = await this.suiClient.getObject({
      id: objectId,
      options: {
        showContent: true,
        showOwner: true,
        showType: true,
      },
    });

    if (!response.data?.content || response.data.content.dataType !== 'moveObject') {
      throw new Error(`Object ${objectId} was not found or does not contain Move object data.`);
    }

    const normalized = normalizeMoveValue(response.data.content.fields);
    if (!isRecord(normalized)) {
      throw new Error(`Object ${objectId} did not resolve to a field record.`);
    }

    return {
      objectId: response.data.objectId,
      objectType: response.data.type ?? undefined,
      objectOwner: normalizeObjectOwner(response.data.owner),
      ...normalized,
    } as T;
  }

  get client(): SuiClient {
    return this.suiClient;
  }

  get config(): NetworkConfig {
    return this.networkConfig;
  }
}

function getExecutionFailure(response: SuiTransactionBlockResponse): SuiTransactionExecutionError | null {
  const status = response.effects?.status;
  if (!status || status.status !== 'failure') {
    return null;
  }

  const rawMessage = typeof status.error === 'string' && status.error.trim() ? status.error.trim() : 'unknown error';
  return new SuiTransactionExecutionError(formatFailureMessage(rawMessage, response.digest), {
    digest: response.digest,
    retryable: isRetryableErrorMessage(rawMessage),
  });
}

function normalizeExecutionError(error: unknown): SuiTransactionExecutionError {
  if (error instanceof SuiTransactionExecutionError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new SuiTransactionExecutionError(formatFailureMessage(message), {
    cause: error,
    retryable: isRetryableErrorMessage(message),
  });
}

function formatFailureMessage(message: string, digest?: string): string {
  const prefix = digest ? `Sui transaction ${digest}` : 'Sui transaction';
  if (/insufficient gas|no valid gas|gas balance|gas coin/i.test(message)) {
    return `${prefix} failed due to insufficient gas: ${message}`;
  }

  if (/object.*(lock|conflict)|equivocat|shared object.*busy/i.test(message)) {
    return `${prefix} failed due to an object lock or conflict: ${message}`;
  }

  return `${prefix} failed: ${message}`;
}

function isRetryableErrorMessage(message: string): boolean {
  return /(timeout|temporar|429|5\d\d|fetch failed|network|connection reset|ECONNRESET|ETIMEDOUT|object.*(lock|conflict)|equivocat|busy)/i.test(
    message,
  );
}

function getRetryDelayMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
