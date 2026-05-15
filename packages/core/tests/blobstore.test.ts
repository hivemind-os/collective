import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemBlobStore } from '../src/index.js';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createBaseDir(): Promise<string> {
  const baseDir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(baseDir);
  await mkdir(baseDir, { recursive: true });
  return baseDir;
}

describe('FilesystemBlobStore', () => {
  it('stores blobs with a SHA-256 checksum', async () => {
    const store = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('hello world');

    const result = await store.store(data);
    const checksum = createHash('sha256').update(data).digest('hex');

    expect(result.blobId).toBe(checksum);
    expect(result.checksum).toBe(checksum);
  });

  it('fetches stored blobs', async () => {
    const store = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('fetch me');
    const { blobId } = await store.store(data);

    const fetched = await store.fetch(blobId);
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
  });

  it('returns null for missing blobs and after delete', async () => {
    const store = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('delete me');
    const { blobId } = await store.store(data);

    expect(await store.fetch('missing')).toBeNull();
    await store.delete(blobId);
    expect(await store.fetch(blobId)).toBeNull();
  });

  it('uses content-addressed ids for identical blobs', async () => {
    const store = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('same data');

    const first = await store.store(data);
    const second = await store.store(data);

    expect(first.blobId).toBe(second.blobId);
    expect(await store.exists(first.blobId)).toBe(true);
  });
});
