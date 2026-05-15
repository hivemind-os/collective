import { createHash } from 'node:crypto';

import {
  BlobIntegrityError,
  FilesystemBlobStore,
  HybridBlobStore,
  WalrusBlobStore,
  parseWalrusBlobReference,
} from '@agentic-mesh/core';
import { afterAll, describe, expect, it } from 'vitest';

import { MockWalrusServer, PortAllocator } from '../harness/index.js';
import { createArtifactDir, createArtifactRoot, removeDirectoryWithRetries } from './test-helpers.js';

const encoder = new TextEncoder();

let artifactRoot: string;

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
});

describe('Phase 1 Beta E2E: Hybrid blobstore', () => {
  it('stores on Walrus and caches locally when Walrus is available', async () => {
    artifactRoot ??= await createArtifactRoot('hybrid-blobstore');
    const harness = await startHybridHarness();

    try {
      const data = encoder.encode('walrus-preferred-data');
      const stored = await harness.hybrid.store(data);

      expect(stored.blobId).toMatch(/^walrus:/);
      expect(harness.server.getRequestCounts().put).toBe(1);
      expect(await harness.local.exists(sha256(data))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it('falls back to the filesystem when Walrus is down', async () => {
    artifactRoot ??= await createArtifactRoot('hybrid-blobstore');
    const harness = await startHybridHarness();

    try {
      const data = encoder.encode('filesystem-fallback');
      await harness.server.stop();

      const stored = await harness.hybrid.store(data);

      expect(stored.blobId).toBe(sha256(data));
      expect(await harness.local.exists(stored.blobId)).toBe(true);
    } finally {
      await harness.portAllocator.release([harness.port]);
    }
  });

  it('returns from the local cache without calling Walrus when the blob is already cached', async () => {
    artifactRoot ??= await createArtifactRoot('hybrid-blobstore');
    const harness = await startHybridHarness();

    try {
      const data = encoder.encode('cached-fetch');
      const stored = await harness.hybrid.store(data);
      const before = harness.server.getRequestCounts();
      await harness.server.stop();

      const fetched = await harness.hybrid.fetch(stored.blobId);

      expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
      expect(harness.server.getRequestCounts().get).toBe(before.get);
    } finally {
      await harness.portAllocator.release([harness.port]);
    }
  });

  it('fetches from Walrus on a local cache miss and then caches the blob locally', async () => {
    artifactRoot ??= await createArtifactRoot('hybrid-blobstore');
    const harness = await startHybridHarness();

    try {
      const data = encoder.encode('remote-then-cached');
      const remoteStored = await harness.walrus.store(data);

      const fetched = await harness.hybrid.fetch(remoteStored.blobId);

      expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
      expect(harness.server.getRequestCounts().get).toBe(1);
      expect(await harness.local.exists(sha256(data))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it('verifies content integrity when fetching a Walrus blob through the hybrid store', async () => {
    artifactRoot ??= await createArtifactRoot('hybrid-blobstore');
    const harness = await startHybridHarness();

    try {
      const data = encoder.encode('integrity-checked');
      const remoteStored = await harness.walrus.store(data);
      const storageBlobId = parseWalrusBlobReference(remoteStored.blobId).storageBlobId;
      harness.server.corruptBlob(storageBlobId, encoder.encode('tampered-payload'));

      await expect(harness.hybrid.fetch(remoteStored.blobId)).rejects.toBeInstanceOf(BlobIntegrityError);
    } finally {
      await harness.cleanup();
    }
  });
});

async function startHybridHarness() {
  const portAllocator = new PortAllocator();
  const [port] = await portAllocator.allocate(1);
  const baseDir = await createArtifactDir(artifactRoot ?? (artifactRoot = await createArtifactRoot('hybrid-blobstore')), 'hybrid');
  const server = new MockWalrusServer();
  await server.start(port);

  const local = new FilesystemBlobStore(baseDir);
  const walrus = new WalrusBlobStore({
    publisherUrl: server.publisherUrl,
    aggregatorUrl: server.aggregatorUrl,
    epochs: 5,
    timeoutMs: 1_000,
    retryAttempts: 1,
    retryDelayMs: 25,
  });
  const hybrid = new HybridBlobStore(walrus, local, { preferWalrus: true, cacheLocally: true });

  return {
    portAllocator,
    port,
    server,
    local,
    walrus,
    hybrid,
    cleanup: async () => {
      await server.stop();
      await portAllocator.release([port]);
    },
  };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
