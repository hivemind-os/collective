import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  BlobIntegrityError,
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  WalrusBlobStore,
  WalrusBlobTooLargeError,
  WalrusHttpError,
  WalrusResponseError,
  WalrusTimeoutError,
  createWalrusBlobReference,
} from '../src/index.js';

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();
const walrusStorageBlobId = Buffer.alloc(32, 0x11).toString('base64url');

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createStore(fetchImpl: typeof fetch): WalrusBlobStore {
  return new WalrusBlobStore({
    publisherUrl: 'https://publisher.example.com',
    aggregatorUrl: 'https://aggregator.example.com',
    epochs: 5,
    retryAttempts: 3,
    retryDelayMs: 1,
    timeoutMs: 10,
    fetchImpl,
  });
}

describe('WalrusBlobStore', () => {
  it('rejects invalid Walrus URLs during startup', () => {
    expect(
      () => new WalrusBlobStore({ publisherUrl: 'not-a-url', aggregatorUrl: 'https://aggregator.example.com' }),
    ).toThrow('Invalid Walrus URL configuration: publisherUrl=not-a-url, aggregatorUrl=https://aggregator.example.com');
  });

  it('warns when configured with testnet Walrus endpoints', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    new WalrusBlobStore({
      publisherUrl: DEFAULT_WALRUS_PUBLISHER_URL,
      aggregatorUrl: DEFAULT_WALRUS_AGGREGATOR_URL,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        publisherUrl: DEFAULT_WALRUS_PUBLISHER_URL,
        aggregatorUrl: DEFAULT_WALRUS_AGGREGATOR_URL,
      },
      'Walrus store is configured with testnet endpoints. Set publisherUrl/aggregatorUrl for production use.',
    );
  });

  it('stores blobs with the Walrus publisher API', async () => {
    const data = encoder.encode('store me');
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(
      new Response(
        JSON.stringify({
          newlyCreated: {
            blobObject: {
              id: '0xblob-object',
              blobId: walrusStorageBlobId,
              size: data.byteLength,
              deletable: false,
              storage: { endEpoch: 12 },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const store = createStore(fetchImpl);

    const result = await store.store(data);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsedUrl = new URL(String(url));

    expect(parsedUrl.origin).toBe('https://publisher.example.com');
    expect(parsedUrl.pathname).toBe('/v1/blobs');
    expect(parsedUrl.searchParams.get('epochs')).toBe('5');
    expect(parsedUrl.searchParams.get('permanent')).toBe('true');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/octet-stream' });
    expect(result).toMatchObject({
      blobId: createWalrusBlobReference(walrusStorageBlobId, sha256(data)),
      hash: sha256(data),
      checksum: sha256(data),
      contentHash: sha256(data),
      size: data.byteLength,
      storageBlobId: walrusStorageBlobId,
      objectId: '0xblob-object',
    });
  });

  it('fetches blobs from the Walrus aggregator API', async () => {
    const data = encoder.encode('fetch me');
    const blobId = createWalrusBlobReference(walrusStorageBlobId, sha256(data));
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response(data, { status: 200 }));
    const store = createStore(fetchImpl);

    const fetched = await store.fetch(blobId);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];

    expect(String(url)).toBe(`https://aggregator.example.com/v1/blobs/${walrusStorageBlobId}`);
    expect(init?.method).toBe('GET');
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
  });

  it('retries transient failures', async () => {
    const data = encoder.encode('retry me');
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(new Response('temporary outage', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            newlyCreated: {
              blobObject: {
                id: '0xblob-object',
                blobId: walrusStorageBlobId,
                size: data.byteLength,
                deletable: false,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const store = createStore(fetchImpl);

    const result = await store.store(data);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.hash).toBe(sha256(data));
  });

  it('fails fast on permanent errors', async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response('bad request', { status: 400 }));
    const store = createStore(fetchImpl);

    await expect(store.store(encoder.encode('boom'))).rejects.toBeInstanceOf(WalrusHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats malformed publisher responses as permanent protocol errors', async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response('not-json', { status: 200 }));
    const store = createStore(fetchImpl);

    await expect(store.store(encoder.encode('boom'))).rejects.toBeInstanceOf(WalrusResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the size limit before upload', async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const store = new WalrusBlobStore({
      publisherUrl: 'https://publisher.example.com',
      aggregatorUrl: 'https://aggregator.example.com',
      maxBlobSize: 4,
      fetchImpl,
    });

    await expect(store.store(encoder.encode('oversized'))).rejects.toBeInstanceOf(WalrusBlobTooLargeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out stalled requests', async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
      return new Response(null, { status: 500 });
    });
    const store = new WalrusBlobStore({
      publisherUrl: 'https://publisher.example.com',
      aggregatorUrl: 'https://aggregator.example.com',
      timeoutMs: 5,
      retryAttempts: 1,
      retryDelayMs: 1,
      fetchImpl,
    });

    await expect(store.store(encoder.encode('slow'))).rejects.toBeInstanceOf(WalrusTimeoutError);
  });

  it('verifies content integrity on fetch', async () => {
    const data = encoder.encode('safe payload');
    const corrupted = encoder.encode('corrupted payload');
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            newlyCreated: {
              blobObject: {
                id: '0xblob-object',
                blobId: walrusStorageBlobId,
                size: data.byteLength,
                deletable: false,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(corrupted, { status: 200 }));
    const store = createStore(fetchImpl);
    const stored = await store.store(data);

    await expect(store.fetch(stored.blobId)).rejects.toBeInstanceOf(BlobIntegrityError);
  });
});
