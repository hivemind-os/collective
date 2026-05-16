import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import pino from 'pino';

import { BlobIntegrityError, type BlobMetadata, type BlobStore, type StoredBlob } from './interface.js';

export const DEFAULT_WALRUS_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space';
export const DEFAULT_WALRUS_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space';
export const DEFAULT_WALRUS_EPOCHS = 5;
export const DEFAULT_WALRUS_MAX_BLOB_SIZE = 10 * 1024 * 1024;
export const DEFAULT_WALRUS_RETRY_ATTEMPTS = 3;
export const DEFAULT_WALRUS_RETRY_DELAY_MS = 1_000;
export const DEFAULT_WALRUS_TIMEOUT_MS = 30_000;

const WALRUS_STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WALRUS_REFERENCE_PATTERN = /^walrus:([A-Za-z0-9_-]{43}):([a-f0-9]{64})$/;
const WALRUS_STORAGE_ID_BYTES = 32;
const logger = pino({ name: '@hivemind-os/collective-core:blobstore:walrus' });

export interface WalrusLogger {
  debug(bindings: Record<string, unknown>, message?: string): void;
  info(bindings: Record<string, unknown>, message?: string): void;
  warn(bindings: Record<string, unknown>, message?: string): void;
  error(bindings: Record<string, unknown>, message?: string): void;
}

export interface WalrusBlobStoreConfig {
  publisherUrl: string;
  aggregatorUrl: string;
  epochs?: number;
  maxBlobSize?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: WalrusLogger;
}

export interface WalrusBlobMetadata extends BlobMetadata {
  storageBlobId: string;
  objectId?: string;
  deletable?: boolean;
  endEpoch?: number;
}

export interface WalrusBlobReference {
  blobId: string;
  storageBlobId: string;
  contentHash?: string;
}

interface WalrusBlobObject {
  id: string;
  blobId: string;
  size: number;
  deletable: boolean;
  storage?: {
    endEpoch?: number;
  };
}

interface WalrusNewlyCreatedResponse {
  newlyCreated: {
    blobObject: WalrusBlobObject;
  };
}

interface WalrusAlreadyCertifiedResponse {
  alreadyCertified: {
    blobId: string;
    endEpoch?: number;
  };
}

type WalrusStoreApiResponse = WalrusNewlyCreatedResponse | WalrusAlreadyCertifiedResponse;

export class WalrusRequestError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly transient: boolean,
    readonly status?: number,
    readonly body?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalrusRequestError';
  }
}

export class WalrusNetworkError extends WalrusRequestError {
  constructor(message: string, url: string, options?: ErrorOptions) {
    super(message, url, true, undefined, undefined, options);
    this.name = 'WalrusNetworkError';
  }
}

export class WalrusTimeoutError extends WalrusRequestError {
  constructor(message: string, url: string, readonly timeoutMs: number, options?: ErrorOptions) {
    super(message, url, true, undefined, undefined, options);
    this.name = 'WalrusTimeoutError';
  }
}

export class WalrusHttpError extends WalrusRequestError {
  constructor(message: string, url: string, status: number, body: string) {
    super(message, url, status >= 500 || status === 408 || status === 429, status, body);
    this.name = 'WalrusHttpError';
  }
}

export class WalrusResponseError extends WalrusRequestError {
  constructor(message: string, url: string, body: string, options?: ErrorOptions) {
    super(message, url, false, undefined, body, options);
    this.name = 'WalrusResponseError';
  }
}

export class WalrusBlobTooLargeError extends Error {
  constructor(readonly size: number, readonly maxBlobSize: number) {
    super(`Walrus blob size ${size} exceeds the configured maximum of ${maxBlobSize} bytes.`);
    this.name = 'WalrusBlobTooLargeError';
  }
}

export class WalrusBlobStore implements BlobStore {
  private readonly config: Required<Omit<WalrusBlobStoreConfig, 'logger' | 'fetchImpl'>> & Pick<WalrusBlobStoreConfig, 'logger' | 'fetchImpl'>;
  private readonly metadata = new Map<string, WalrusBlobMetadata>();

  constructor(config: WalrusBlobStoreConfig) {
    this.config = {
      publisherUrl: normalizeWalrusUrl(config.publisherUrl || DEFAULT_WALRUS_PUBLISHER_URL),
      aggregatorUrl: normalizeWalrusUrl(config.aggregatorUrl || DEFAULT_WALRUS_AGGREGATOR_URL),
      epochs: config.epochs ?? DEFAULT_WALRUS_EPOCHS,
      maxBlobSize: config.maxBlobSize ?? DEFAULT_WALRUS_MAX_BLOB_SIZE,
      retryAttempts: Math.max(1, config.retryAttempts ?? DEFAULT_WALRUS_RETRY_ATTEMPTS),
      retryDelayMs: Math.max(1, config.retryDelayMs ?? DEFAULT_WALRUS_RETRY_DELAY_MS),
      timeoutMs: Math.max(1, config.timeoutMs ?? DEFAULT_WALRUS_TIMEOUT_MS),
      fetchImpl: config.fetchImpl,
      logger: config.logger,
    };

    validatePositiveInteger(this.config.epochs, 'epochs');
    validatePositiveInteger(this.config.maxBlobSize, 'maxBlobSize');
    validatePositiveInteger(this.config.timeoutMs, 'timeoutMs');
  }

  async store(data: Uint8Array): Promise<StoredBlob> {
    if (data.byteLength > this.config.maxBlobSize) {
      throw new WalrusBlobTooLargeError(data.byteLength, this.config.maxBlobSize);
    }

    const contentHash = computeSha256(data);
    const startedAt = Date.now();
    const started = performance.now();
    const storeUrl = new URL(`${this.config.publisherUrl}/v1/blobs`);
    storeUrl.searchParams.set('epochs', String(this.config.epochs));
    storeUrl.searchParams.set('permanent', 'true');

    const response = await this.executeWithRetry('store', storeUrl.toString(), async () => {
      const walrusResponse = await this.fetchWithTimeout(storeUrl.toString(), {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
        },
        body: data,
      });
      const body = await walrusResponse.text();

      if (!walrusResponse.ok) {
        throw new WalrusHttpError(
          `Walrus store failed with status ${walrusResponse.status}: ${body}`,
          storeUrl.toString(),
          walrusResponse.status,
          body,
        );
      }

      return parseWalrusStorePayload(body, storeUrl.toString());
    }, { size: data.byteLength });

    const blobId = createWalrusBlobReference(response.storageBlobId, contentHash);
    const stored: WalrusBlobMetadata & StoredBlob = {
      blobId,
      hash: contentHash,
      checksum: contentHash,
      contentHash,
      size: response.size ?? data.byteLength,
      storedAt: startedAt,
      storageBlobId: response.storageBlobId,
      objectId: response.objectId,
      deletable: response.deletable,
      endEpoch: response.endEpoch,
    };

    this.rememberMetadata(stored);
    this.log('info', {
      operation: 'store',
      blobId,
      storageBlobId: response.storageBlobId,
      size: data.byteLength,
      durationMs: Math.round(performance.now() - started),
    }, 'Stored Walrus blob');

    return stored;
  }

  async fetch(blobId: string): Promise<Uint8Array | null> {
    const reference = parseWalrusBlobReference(blobId);
    const started = performance.now();
    const url = `${this.config.aggregatorUrl}/v1/blobs/${reference.storageBlobId}`;

    const data = await this.executeWithRetry('fetch', url, async () => {
      const response = await this.fetchWithTimeout(url, { method: 'GET' });
      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new WalrusHttpError(
          `Walrus fetch failed with status ${response.status}: ${body}`,
          url,
          response.status,
          body,
        );
      }

      return new Uint8Array(await response.arrayBuffer());
    }, { blobId: reference.storageBlobId });

    if (!data) {
      return null;
    }

    const actualHash = computeSha256(data);
    const expectedHash = reference.contentHash ?? this.metadata.get(blobId)?.contentHash ?? this.metadata.get(reference.storageBlobId)?.contentHash;
    if (expectedHash && actualHash !== expectedHash) {
      this.log('error', {
        operation: 'fetch',
        blobId,
        storageBlobId: reference.storageBlobId,
        expectedHash,
        actualHash,
      }, 'Walrus blob failed integrity verification');
      throw new BlobIntegrityError(
        `Walrus blob ${blobId} failed SHA-256 verification.`,
        blobId,
        expectedHash,
        actualHash,
      );
    }

    const metadata = this.metadata.get(blobId) ?? this.metadata.get(reference.storageBlobId);
    if (!metadata) {
      this.rememberMetadata({
        blobId: reference.contentHash ? blobId : createWalrusBlobReference(reference.storageBlobId, actualHash),
        contentHash: actualHash,
        size: data.byteLength,
        storedAt: Date.now(),
        storageBlobId: reference.storageBlobId,
      });
    }

    this.log('info', {
      operation: 'fetch',
      blobId,
      storageBlobId: reference.storageBlobId,
      size: data.byteLength,
      durationMs: Math.round(performance.now() - started),
    }, 'Fetched Walrus blob');

    return data;
  }

  async exists(blobId: string): Promise<boolean> {
    const reference = parseWalrusBlobReference(blobId);
    const url = `${this.config.aggregatorUrl}/v1/blobs/${reference.storageBlobId}`;

    return await this.executeWithRetry('exists', url, async () => {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-0',
        },
      });

      if (response.status === 404) {
        return false;
      }

      if (response.status === 200 || response.status === 206) {
        return true;
      }

      const body = await response.text();
      throw new WalrusHttpError(
        `Walrus exists check failed with status ${response.status}: ${body}`,
        url,
        response.status,
        body,
      );
    }, { blobId: reference.storageBlobId });
  }

  async getMetadata(blobId: string): Promise<BlobMetadata | null> {
    const directMatch = this.metadata.get(blobId);
    if (directMatch) {
      return directMatch;
    }

    try {
      return this.metadata.get(parseWalrusBlobReference(blobId).storageBlobId) ?? null;
    } catch {
      return null;
    }
  }

  async delete(blobId: string): Promise<void> {
    void blobId;
    throw new Error(
      'Walrus deletion is not available through the public HTTP API. Deleting or extending blobs requires owning the Walrus Blob object and using the CLI or on-chain APIs.',
    );
  }

  private async executeWithRetry<T>(
    operation: 'store' | 'fetch' | 'exists',
    url: string,
    action: () => Promise<T>,
    context: Record<string, unknown> = {},
  ): Promise<T> {
    let attempt = 0;
    while (attempt < this.config.retryAttempts) {
      attempt += 1;
      try {
        return await action();
      } catch (error) {
        const walrusError = classifyWalrusError(error, url, this.config.timeoutMs);
        if (!walrusError.transient || attempt >= this.config.retryAttempts) {
          this.log('error', {
            operation,
            attempt,
            retryAttempts: this.config.retryAttempts,
            transient: walrusError.transient,
            url,
            err: walrusError,
            ...context,
          }, 'Walrus request failed');
          throw walrusError;
        }

        const delayMs = this.config.retryDelayMs * (2 ** (attempt - 1));
        this.log('warn', {
          operation,
          attempt,
          retryAttempts: this.config.retryAttempts,
          delayMs,
          url,
          err: walrusError,
          ...context,
        }, 'Retrying Walrus request');
        await sleep(delayMs);
      }
    }

    throw new Error(`Walrus ${operation} exhausted retries for ${url}.`);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const walrusFetch = this.config.fetchImpl ?? globalThis.fetch;
    if (!walrusFetch) {
      throw new Error('Global fetch is not available in this runtime.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      return await walrusFetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WalrusTimeoutError(
          `Walrus request timed out after ${this.config.timeoutMs}ms for ${url}.`,
          url,
          this.config.timeoutMs,
          { cause: error as Error },
        );
      }

      throw new WalrusNetworkError(
        `Walrus request failed for ${url}: ${(error as Error).message}`,
        url,
        { cause: error as Error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private rememberMetadata(metadata: WalrusBlobMetadata): void {
    this.metadata.set(metadata.blobId, metadata);
    this.metadata.set(metadata.storageBlobId, metadata);
  }

  private log(level: keyof WalrusLogger, bindings: Record<string, unknown>, message: string): void {
    const targetLogger = this.config.logger ?? logger;
    targetLogger[level](bindings, message);
  }
}

export function createWalrusBlobReference(storageBlobId: string, contentHash: string): string {
  assertWalrusStorageBlobId(storageBlobId);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error(`Invalid SHA-256 content hash: ${contentHash}`);
  }

  return `walrus:${storageBlobId}:${contentHash}`;
}

export function parseWalrusBlobReference(blobId: string): WalrusBlobReference {
  const encodedMatch = WALRUS_REFERENCE_PATTERN.exec(blobId);
  if (encodedMatch) {
    assertWalrusStorageBlobId(encodedMatch[1]);
    return {
      blobId,
      storageBlobId: encodedMatch[1],
      contentHash: encodedMatch[2],
    };
  }

  assertWalrusStorageBlobId(blobId);
  return {
    blobId,
    storageBlobId: blobId,
  };
}

function parseWalrusStorePayload(
  body: string,
  url: string,
): Omit<WalrusBlobMetadata, 'blobId' | 'contentHash' | 'storedAt' | 'size'> & { size?: number } {
  let response: unknown;
  try {
    response = JSON.parse(body);
  } catch (error) {
    throw new WalrusResponseError(`Walrus store returned invalid JSON from ${url}.`, url, body, {
      cause: error as Error,
    });
  }

  try {
    return parseWalrusStoreResponse(response as WalrusStoreApiResponse);
  } catch (error) {
    throw new WalrusResponseError(
      error instanceof Error ? error.message : 'Unexpected Walrus store response payload.',
      url,
      body,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function parseWalrusStoreResponse(
  response: WalrusStoreApiResponse,
): Omit<WalrusBlobMetadata, 'blobId' | 'contentHash' | 'storedAt' | 'size'> & { size?: number } {
  if ('newlyCreated' in response) {
    const { blobObject } = response.newlyCreated;
    assertWalrusStorageBlobId(blobObject.blobId);
    return {
      storageBlobId: blobObject.blobId,
      objectId: blobObject.id,
      size: blobObject.size,
      deletable: blobObject.deletable,
      endEpoch: blobObject.storage?.endEpoch,
    };
  }

  if ('alreadyCertified' in response) {
    assertWalrusStorageBlobId(response.alreadyCertified.blobId);
    return {
      storageBlobId: response.alreadyCertified.blobId,
      endEpoch: response.alreadyCertified.endEpoch,
    };
  }

  throw new Error('Unexpected Walrus store response payload.');
}

function assertWalrusStorageBlobId(blobId: string): void {
  if (!WALRUS_STORAGE_ID_PATTERN.test(blobId)) {
    throw new Error(`Invalid Walrus blob ID: ${blobId}`);
  }

  const bytes = Buffer.from(blobId, 'base64url');
  if (bytes.length !== WALRUS_STORAGE_ID_BYTES) {
    throw new Error(
      `Expected Walrus blob IDs to decode to ${WALRUS_STORAGE_ID_BYTES} bytes, got ${bytes.length}`,
    );
  }
}

function normalizeWalrusUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer, received ${value}.`);
  }
}

function computeSha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function classifyWalrusError(error: unknown, url: string, timeoutMs: number): WalrusRequestError {
  if (error instanceof WalrusRequestError) {
    return error;
  }

  if (error instanceof BlobIntegrityError) {
    return new WalrusRequestError(error.message, url, false, undefined, undefined, { cause: error });
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new WalrusTimeoutError(
      `Walrus request timed out after ${timeoutMs}ms for ${url}.`,
      url,
      timeoutMs,
      { cause: error },
    );
  }

  if (error instanceof Error) {
    return new WalrusNetworkError(error.message, url, { cause: error });
  }

  return new WalrusNetworkError(`Unknown Walrus request failure for ${url}.`, url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
