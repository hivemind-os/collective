import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export const DEFAULT_WALRUS_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space';
export const DEFAULT_WALRUS_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space';
export const DEFAULT_WALRUS_EPOCHS = 1;
export const WALRUS_BLOB_ID_BYTES = 32;

const WALRUS_BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface WalrusEndpoints {
  publisherUrl?: string;
  aggregatorUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WalrusStoreOptions extends WalrusEndpoints {
  epochs?: number;
  permanent?: boolean;
  deletable?: boolean;
  contentType?: string;
}

export interface WalrusBlobMetadata {
  blobId: string;
  objectId?: string;
  size?: number;
  deletable?: boolean;
  endEpoch?: number;
  rawResponse: WalrusStoreApiResponse;
}

export interface WalrusStoreResult extends WalrusBlobMetadata {
  checksum: string;
  storeMs: number;
}

export interface WalrusRoundTripResult extends WalrusStoreResult {
  blobIdBytes: Uint8Array;
  fetchedChecksum: string;
  fetchMs: number;
  fetchedBytes: Uint8Array;
  contentMatches: boolean;
}

export interface WalrusSpikeOptions extends WalrusStoreOptions {
  data?: Uint8Array;
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

export type WalrusStoreApiResponse = WalrusNewlyCreatedResponse | WalrusAlreadyCertifiedResponse;

export class WalrusHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(message: string, status: number, url: string, body: string) {
    super(message);
    this.name = 'WalrusHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class WalrusNetworkError extends Error {
  readonly url: string;

  constructor(message: string, url: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalrusNetworkError';
    this.url = url;
  }
}

export function computeWalrusChecksum(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function decodeWalrusBlobId(blobId: string): Uint8Array {
  if (!WALRUS_BLOB_ID_PATTERN.test(blobId)) {
    throw new Error(`Invalid Walrus blob ID: ${blobId}`);
  }

  const bytes = Buffer.from(blobId, 'base64url');
  if (bytes.length !== WALRUS_BLOB_ID_BYTES) {
    throw new Error(
      `Expected Walrus blob IDs to decode to ${WALRUS_BLOB_ID_BYTES} bytes, got ${bytes.length}`,
    );
  }

  return new Uint8Array(bytes);
}

export function walrusBlobIdToMoveVector(blobId: string): Uint8Array {
  return decodeWalrusBlobId(blobId);
}

export function moveVectorToWalrusBlobId(bytes: Uint8Array): string {
  if (bytes.length !== WALRUS_BLOB_ID_BYTES) {
    throw new Error(
      `Expected ${WALRUS_BLOB_ID_BYTES} bytes when converting Move blob IDs, got ${bytes.length}`,
    );
  }

  return Buffer.from(bytes).toString('base64url');
}

export async function storeBlobOnWalrus(
  data: Uint8Array,
  options: WalrusStoreOptions = {},
): Promise<WalrusStoreResult> {
  if (options.permanent && options.deletable) {
    throw new Error('Walrus blobs cannot be both permanent and deletable.');
  }

  const url = new URL(`${normalizeWalrusUrl(options.publisherUrl ?? DEFAULT_WALRUS_PUBLISHER_URL)}/v1/blobs`);
  const epochs = options.epochs ?? DEFAULT_WALRUS_EPOCHS;
  validateEpochs(epochs);
  url.searchParams.set('epochs', String(epochs));

  if (options.permanent) {
    url.searchParams.set('permanent', 'true');
  }

  if (options.deletable) {
    url.searchParams.set('deletable', 'true');
  }

  const requestStart = performance.now();
  const response = await requestWalrus(url.toString(), {
    method: 'PUT',
    headers: {
      'content-type': options.contentType ?? 'application/octet-stream',
    },
    body: data,
  }, options.fetchImpl);
  const storeMs = Math.round(performance.now() - requestStart);
  const body = await response.text();

  if (!response.ok) {
    throw new WalrusHttpError(
      `Walrus store failed with status ${response.status}: ${body}`,
      response.status,
      url.toString(),
      body,
    );
  }

  const rawResponse = JSON.parse(body) as WalrusStoreApiResponse;
  const metadata = parseWalrusStoreResponse(rawResponse);

  return {
    ...metadata,
    checksum: computeWalrusChecksum(data),
    storeMs,
  };
}

export async function fetchBlobFromWalrus(
  blobId: string,
  options: WalrusEndpoints = {},
): Promise<Uint8Array | null> {
  decodeWalrusBlobId(blobId);

  const url = `${normalizeWalrusUrl(options.aggregatorUrl ?? DEFAULT_WALRUS_AGGREGATOR_URL)}/v1/blobs/${blobId}`;
  const response = await requestWalrus(url, { method: 'GET' }, options.fetchImpl);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new WalrusHttpError(
      `Walrus fetch failed with status ${response.status}: ${body}`,
      response.status,
      url,
      body,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function walrusBlobExists(
  blobId: string,
  options: WalrusEndpoints = {},
): Promise<boolean> {
  decodeWalrusBlobId(blobId);

  const url = `${normalizeWalrusUrl(options.aggregatorUrl ?? DEFAULT_WALRUS_AGGREGATOR_URL)}/v1/blobs/${blobId}`;
  const response = await requestWalrus(
    url,
    {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    },
    options.fetchImpl,
  );

  if (response.status === 404) {
    return false;
  }

  if (response.status === 200 || response.status === 206) {
    return true;
  }

  const body = await response.text();
  throw new WalrusHttpError(
    `Walrus exists check failed with status ${response.status}: ${body}`,
    response.status,
    url,
    body,
  );
}

export async function runWalrusSpike(
  options: WalrusSpikeOptions = {},
): Promise<WalrusRoundTripResult> {
  const data = options.data ?? new TextEncoder().encode('Hello, Walrus!');
  const stored = await storeBlobOnWalrus(data, options);
  const fetchStart = performance.now();
  const fetchedBytes = await fetchBlobFromWalrus(stored.blobId, options);
  const fetchMs = Math.round(performance.now() - fetchStart);

  if (!fetchedBytes) {
    throw new Error(`Walrus blob ${stored.blobId} was stored but could not be fetched.`);
  }

  const fetchedChecksum = computeWalrusChecksum(fetchedBytes);

  return {
    ...stored,
    blobIdBytes: walrusBlobIdToMoveVector(stored.blobId),
    fetchedChecksum,
    fetchMs,
    fetchedBytes,
    contentMatches: fetchedChecksum === stored.checksum,
  };
}

function normalizeWalrusUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function validateEpochs(epochs: number): void {
  if (!Number.isInteger(epochs) || epochs < 1) {
    throw new Error(`Walrus epochs must be a positive integer, received ${epochs}`);
  }
}

function parseWalrusStoreResponse(response: WalrusStoreApiResponse): WalrusBlobMetadata {
  if ('newlyCreated' in response) {
    const { blobObject } = response.newlyCreated;
    decodeWalrusBlobId(blobObject.blobId);
    return {
      blobId: blobObject.blobId,
      objectId: blobObject.id,
      size: blobObject.size,
      deletable: blobObject.deletable,
      endEpoch: blobObject.storage?.endEpoch,
      rawResponse: response,
    };
  }

  if ('alreadyCertified' in response) {
    decodeWalrusBlobId(response.alreadyCertified.blobId);
    return {
      blobId: response.alreadyCertified.blobId,
      endEpoch: response.alreadyCertified.endEpoch,
      rawResponse: response,
    };
  }

  throw new Error('Unexpected Walrus store response payload.');
}

async function requestWalrus(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> {
  const walrusFetch = fetchImpl ?? globalThis.fetch;
  if (!walrusFetch) {
    throw new Error('Global fetch is not available in this runtime.');
  }

  try {
    return await walrusFetch(url, init);
  } catch (error) {
    throw new WalrusNetworkError(
      `Walrus request failed for ${url}: ${(error as Error).message}`,
      url,
      { cause: error as Error },
    );
  }
}

async function main(): Promise<void> {
  const result = await runWalrusSpike({ permanent: true });
  console.log(
    JSON.stringify(
      {
        ...result,
        blobIdBytes: Array.from(result.blobIdBytes),
        fetchedBytes: Array.from(result.fetchedBytes),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
