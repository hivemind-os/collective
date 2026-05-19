import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlobIntegrityError, FilesystemBlobStore } from '../src/index.js';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
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
  it('stores blobs with SHA-256 metadata', async () => {
    const store = new FilesystemBlobStore(await createBaseDir());
    const data = encoder.encode('hello world');

    const result = await store.store(data);
    const checksum = createHash('sha256').update(data).digest('hex');

    expect(result).toMatchObject({
      blobId: checksum,
      hash: checksum,
      checksum,
      contentHash: checksum,
      size: data.byteLength,
    });
    expect(result.storedAt).toBeGreaterThan(0);
  });

  it('fetches stored blobs and returns metadata', async () => {
    const baseDir = await createBaseDir();
    const store = new FilesystemBlobStore(baseDir);
    const data = encoder.encode('fetch me');
    const { blobId } = await store.store(data);

    const fetched = await store.fetch(blobId);
    const metadata = await store.getMetadata(blobId);

    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
    expect(metadata).toMatchObject({
      blobId,
      contentHash: blobId,
      size: data.byteLength,
    });
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

  it('throws on content corruption', async () => {
    const baseDir = await createBaseDir();
    const store = new FilesystemBlobStore(baseDir);
    const data = encoder.encode('keep me safe');
    const { blobId } = await store.store(data);

    await writeFile(join(baseDir, blobId), encoder.encode('tampered'));

    await expect(store.fetch(blobId)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('rethrows non-ENOENT errors from exists checks', async () => {
    const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        access: vi.fn().mockRejectedValueOnce(accessError),
      };
    });

    const { FilesystemBlobStore: MockedFilesystemBlobStore } = await import('../src/blobstore/fs-store.js');
    const store = new MockedFilesystemBlobStore(await createBaseDir());

    await expect(store.exists('forbidden')).rejects.toBe(accessError);
  });
});
