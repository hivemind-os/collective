import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BlobStore } from './interface.js';

export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  async store(data: Uint8Array): Promise<{ blobId: string; checksum: string }> {
    await mkdir(this.baseDir, { recursive: true });
    const checksum = createHash('sha256').update(data).digest('hex');
    const blobPath = join(this.baseDir, checksum);

    try {
      await writeFile(blobPath, data, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    return { blobId: checksum, checksum };
  }

  async fetch(blobId: string): Promise<Uint8Array | null> {
    try {
      const data = await readFile(join(this.baseDir, blobId));
      return new Uint8Array(data);
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
    } catch {
      return false;
    }
  }

  async delete(blobId: string): Promise<void> {
    await rm(join(this.baseDir, blobId), { force: true });
  }
}
