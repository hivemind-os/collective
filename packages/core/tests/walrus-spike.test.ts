import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WalrusBlobStore } from '../src/index.js';
import {
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  WalrusNetworkError,
  fetchBlobFromWalrus,
  moveVectorToWalrusBlobId,
  storeBlobOnWalrus,
  walrusBlobIdToMoveVector,
} from '../src/blobstore/walrus-spike.js';

const runWalrusTestnet = process.env.RUN_WALRUS_TESTNET === '1';
const describeWalrus = runWalrusTestnet ? describe : describe.skip;

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('Walrus spike helpers', () => {
  it('round-trips Walrus blob IDs through Move-friendly bytes', () => {
    const blobId = 'a7wmADgKiwLDFnpjyu6NBTkCS-1zLblj3TfmXZWxnew';

    const moveBytes = walrusBlobIdToMoveVector(blobId);

    expect(moveBytes).toHaveLength(32);
    expect(moveVectorToWalrusBlobId(moveBytes)).toBe(blobId);
  });

  it('wraps network errors', async () => {
    const data = new TextEncoder().encode('offline');

    await expect(
      storeBlobOnWalrus(data, {
        fetchImpl: async () => {
          throw new TypeError('network offline');
        },
      }),
    ).rejects.toBeInstanceOf(WalrusNetworkError);
  });

  it('explains why delete is unsupported', async () => {
    const store = new WalrusBlobStore({
      publisherUrl: DEFAULT_WALRUS_PUBLISHER_URL,
      aggregatorUrl: DEFAULT_WALRUS_AGGREGATOR_URL,
    });

    await expect(store.delete('ignored')).rejects.toThrow(/public HTTP API/i);
  });
});

describeWalrus('Walrus testnet spike', () => {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL;
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL;
  const epochs = Number(process.env.WALRUS_EPOCHS ?? '1');

  it('stores and fetches a small blob with matching SHA-256', async () => {
    const data = new TextEncoder().encode(`Hello, Walrus! ${Date.now()}`);
    const result = await storeBlobOnWalrus(data, {
      publisherUrl,
      aggregatorUrl,
      epochs,
      permanent: true,
    });

    const fetched = await fetchBlobFromWalrus(result.blobId, { aggregatorUrl });

    expect(result.blobId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.storeMs).toBeGreaterThan(0);
    expect(result.checksum).toBe(sha256(data));
    expect(result.deletable).toBe(false);
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
    expect(sha256(fetched ?? new Uint8Array())).toBe(result.checksum);
  }, 120_000);

  it('stores and fetches a 1 MiB blob through WalrusBlobStore', async () => {
    const data = randomBytes(1024 * 1024);
    const store = new WalrusBlobStore({ publisherUrl, aggregatorUrl, epochs });

    const stored = await store.store(data);
    const fetched = await store.fetch(stored.blobId);

    expect(stored.blobId).toMatch(/^walrus:[A-Za-z0-9_-]{43}:[a-f0-9]{64}$/);
    expect(stored.checksum).toBe(sha256(data));
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
    expect(await store.exists(stored.blobId)).toBe(true);
  }, 180_000);

  it('returns null for a missing valid blob ID and errors for malformed IDs', async () => {
    const store = new WalrusBlobStore({ publisherUrl, aggregatorUrl, epochs });
    const missingBlobId = Buffer.alloc(32, 0x11).toString('base64url');

    await expect(store.fetch(missingBlobId)).resolves.toBeNull();
    await expect(store.exists(missingBlobId)).resolves.toBe(false);
    await expect(store.fetch('not-a-real-id')).rejects.toThrow(/Invalid Walrus blob ID/);
  }, 60_000);
});
