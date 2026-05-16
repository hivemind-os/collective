import pino from 'pino';

import type { BlobMetadata, BlobStore, StoredBlob } from './interface.js';
import { FilesystemBlobStore } from './fs-store.js';
import { parseWalrusBlobReference, type WalrusBlobStore } from './walrus-store.js';

const logger = pino({ name: '@hivemind-os/collective-core:blobstore:hybrid' });

export interface HybridBlobStoreOptions {
  preferWalrus?: boolean;
  cacheLocally?: boolean;
}

export class HybridBlobStore implements BlobStore {
  constructor(
    private readonly walrus: WalrusBlobStore,
    private readonly local: FilesystemBlobStore,
    private readonly options: HybridBlobStoreOptions = {},
  ) {}

  async store(data: Uint8Array): Promise<StoredBlob> {
    if (this.preferWalrus) {
      try {
        const stored = await this.walrus.store(data);
        if (this.cacheLocally) {
          await this.local.store(data);
        }
        return stored;
      } catch (error) {
        logger.warn({ err: error, size: data.byteLength }, 'Walrus store failed, falling back to filesystem');
        return await this.local.store(data);
      }
    }

    try {
      return await this.local.store(data);
    } catch (error) {
      logger.warn({ err: error, size: data.byteLength }, 'Filesystem store failed, falling back to Walrus');
      const stored = await this.walrus.store(data);
      if (this.cacheLocally) {
        await this.local.store(data);
      }
      return stored;
    }
  }

  async fetch(blobId: string): Promise<Uint8Array | null> {
    for (const localBlobId of getLocalBlobCandidates(blobId)) {
      const cached = await this.local.fetch(localBlobId);
      if (cached) {
        return cached;
      }
    }

    if (!isWalrusBlobId(blobId)) {
      return null;
    }

    const remote = await this.walrus.fetch(blobId);
    if (remote && this.cacheLocally) {
      await this.local.store(remote);
    }

    return remote;
  }

  async exists(blobId: string): Promise<boolean> {
    for (const localBlobId of getLocalBlobCandidates(blobId)) {
      if (await this.local.exists(localBlobId)) {
        return true;
      }
    }

    return isWalrusBlobId(blobId) ? await this.walrus.exists(blobId) : false;
  }

  async getMetadata(blobId: string): Promise<BlobMetadata | null> {
    if (isWalrusBlobId(blobId)) {
      const walrusMetadata = await this.walrus.getMetadata(blobId);
      if (walrusMetadata) {
        return walrusMetadata;
      }
    }

    for (const localBlobId of getLocalBlobCandidates(blobId)) {
      const localMetadata = await this.local.getMetadata(localBlobId);
      if (localMetadata) {
        return localMetadata;
      }
    }

    return null;
  }

  async delete(blobId: string): Promise<void> {
    const localBlobIds = getLocalBlobCandidates(blobId);
    await Promise.all(localBlobIds.map(async (localBlobId) => {
      if (await this.local.exists(localBlobId)) {
        await this.local.delete(localBlobId);
      }
    }));

    const walrusLikeBlobId = isWalrusBlobId(blobId);
    if (walrusLikeBlobId) {
      await this.walrus.delete(blobId);
    }
  }

  private get preferWalrus(): boolean {
    return this.options.preferWalrus ?? true;
  }

  private get cacheLocally(): boolean {
    return this.options.cacheLocally ?? true;
  }
}

function getLocalBlobCandidates(blobId: string): string[] {
  const candidates = new Set<string>();

  if (/^[a-f0-9]{64}$/.test(blobId)) {
    candidates.add(blobId);
  }

  try {
    const reference = parseWalrusBlobReference(blobId);
    if (reference.contentHash) {
      candidates.add(reference.contentHash);
    }
  } catch {
    // Non-Walrus blob ids are handled by the direct hash case above.
  }

  return [...candidates];
}

function isWalrusBlobId(blobId: string): boolean {
  try {
    parseWalrusBlobReference(blobId);
    return true;
  } catch {
    return false;
  }
}
