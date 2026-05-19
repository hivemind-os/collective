import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilesystemBlobStore, HybridBlobStore, createWalrusBlobReference } from '../src/index.js';
import type { WalrusBlobStore } from '../src/blobstore/walrus-store.js';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

async function createBaseDir(): Promise<string> {
  const baseDir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(baseDir);
  await mkdir(baseDir, { recursive: true });
  return baseDir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('HybridBlobStore', () => {
  it('uses Walrus when available', async () => {
    const local = new FilesystemBlobStore(await createBaseDir());
    const walrus = {
      store: vi.fn().mockResolvedValue({
        blobId: createWalrusBlobReference(Buffer.alloc(32, 0x22).toString('base64url'), 'a'.repeat(64)),
        hash: 'a'.repeat(64),
        checksum: 'a'.repeat(64),
        contentHash: 'a'.repeat(64),
        size: 4,
        storedAt: Date.now(),
      }),
      fetch: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
      getMetadata: vi.fn(),
    } as unknown as WalrusBlobStore;
    const store = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: false });

    const result = await store.store(encoder.encode('data'));

    expect(walrus.store).toHaveBeenCalledTimes(1);
    expect(result.blobId).toContain('walrus:');
  });

  it('falls back to the filesystem when Walrus is unavailable', async () => {
    const local = new FilesystemBlobStore(await createBaseDir());
    const walrus = {
      store: vi.fn().mockRejectedValue(new Error('walrus down')),
      fetch: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
      getMetadata: vi.fn(),
    } as unknown as WalrusBlobStore;
    const store = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: true });
    const data = encoder.encode('fallback');

    const result = await store.store(data);

    expect(result.blobId).toMatch(/^[a-f0-9]{64}$/);
    expect(await local.exists(result.blobId)).toBe(true);
  });

  it('caches Walrus blobs locally and serves fetches from the cache', async () => {
    const local = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('cached');
    const contentHash = sha256(data);
    const walrus = {
      store: vi.fn().mockResolvedValue({
        blobId: createWalrusBlobReference(Buffer.alloc(32, 0x33).toString('base64url'), contentHash),
        hash: contentHash,
        checksum: contentHash,
        contentHash,
        size: data.byteLength,
        storedAt: Date.now(),
      }),
      fetch: vi.fn().mockResolvedValue(data),
      exists: vi.fn(),
      delete: vi.fn(),
      getMetadata: vi.fn(),
    } as unknown as WalrusBlobStore;
    const store = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: true });

    const stored = await store.store(data);
    const fetched = await store.fetch(stored.blobId);

    expect(walrus.store).toHaveBeenCalledTimes(1);
    expect(walrus.fetch).not.toHaveBeenCalled();
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
  });

  it('checks the local cache before querying Walrus', async () => {
    const local = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('remote then cached');
    const contentHash = sha256(data);
    const blobId = createWalrusBlobReference(Buffer.alloc(32, 0x44).toString('base64url'), contentHash);
    const walrus = {
      store: vi.fn(),
      fetch: vi.fn().mockResolvedValue(data),
      exists: vi.fn().mockResolvedValue(true),
      delete: vi.fn(),
      getMetadata: vi.fn(),
    } as unknown as WalrusBlobStore;
    const store = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: true });

    const firstFetch = await store.fetch(blobId);
    const secondFetch = await store.fetch(blobId);

    expect(Buffer.from(firstFetch ?? [])).toEqual(Buffer.from(data));
    expect(Buffer.from(secondFetch ?? [])).toEqual(Buffer.from(data));
    expect(walrus.fetch).toHaveBeenCalledTimes(1);
    expect(await local.exists(contentHash)).toBe(true);
  });

  it('reports partial delete failures with store and blob ids', async () => {
    const contentHash = 'b'.repeat(64);
    const blobId = createWalrusBlobReference(Buffer.alloc(32, 0x55).toString('base64url'), contentHash);
    const local = {
      store: vi.fn(),
      fetch: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockRejectedValue(new Error('local delete failed')),
      getMetadata: vi.fn(),
    } as unknown as FilesystemBlobStore;
    const walrus = {
      store: vi.fn(),
      fetch: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('walrus delete failed')),
      getMetadata: vi.fn(),
    } as unknown as WalrusBlobStore;
    const store = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: false });

    await expect(store.delete(blobId)).rejects.toThrow(
      `Partial delete failure for blob ${blobId}: 2 operation(s) failed (local:${contentHash}, walrus:${blobId})`,
    );
    expect(local.delete).toHaveBeenCalledWith(contentHash);
    expect(walrus.delete).toHaveBeenCalledWith(blobId);
  });
});
