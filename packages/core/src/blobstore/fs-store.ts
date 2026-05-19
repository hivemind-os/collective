import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BlobIntegrityError, type BlobMetadata, type BlobStore, type StoredBlob } from './interface.js';

export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  async store(data: Uint8Array): Promise<StoredBlob> {
    await mkdir(this.baseDir, { recursive: true });
    const checksum = computeChecksum(data);
    const blobPath = join(this.baseDir, checksum);
    const storedAt = Date.now();

    try {
      await writeFile(blobPath, data, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    return {
      blobId: checksum,
      hash: checksum,
      checksum,
      contentHash: checksum,
      size: data.byteLength,
      storedAt,
    };
  }

  async fetch(blobId: string): Promise<Uint8Array | null> {
    try {
      const data = new Uint8Array(await readFile(join(this.baseDir, blobId)));
      const actualHash = computeChecksum(data);
      if (actualHash !== blobId) {
        throw new BlobIntegrityError(
          `Filesystem blob ${blobId} failed SHA-256 verification.`,
          blobId,
          blobId,
          actualHash,
        );
      }

      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async exists(blobId: string): Promise<boolean> {
    try {
      await access(join(this.baseDir, blobId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  async getMetadata(blobId: string): Promise<BlobMetadata | null> {
    try {
      const blobStat = await stat(join(this.baseDir, blobId));
      return {
        blobId,
        contentHash: blobId,
        size: blobStat.size,
        storedAt: Math.round(blobStat.birthtimeMs || blobStat.mtimeMs),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async delete(blobId: string): Promise<void> {
    await rm(join(this.baseDir, blobId), { force: true });
  }
}

function computeChecksum(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
