import type { BlobStore } from '@agentic-mesh/core';

export interface EncryptedBlobStoreLike extends BlobStore {
  storeEncrypted(data: Uint8Array, recipientPublicKey: Uint8Array): Promise<{ blobId: string; hash: string }>;
  fetchDecrypted(blobId: string): Promise<Uint8Array | null>;
}

export function supportsEncryptedBlobs(blobStore: BlobStore): blobStore is EncryptedBlobStoreLike {
  return typeof (blobStore as Partial<EncryptedBlobStoreLike>).storeEncrypted === 'function'
    && typeof (blobStore as Partial<EncryptedBlobStoreLike>).fetchDecrypted === 'function';
}

export async function fetchMeshBlob(blobStore: BlobStore, blobId: string): Promise<Uint8Array | null> {
  return supportsEncryptedBlobs(blobStore)
    ? await blobStore.fetchDecrypted(blobId)
    : await blobStore.fetch(blobId);
}

export function hexToBytes(value?: string): Uint8Array | null {
  if (!value || value.length !== 64 || !/^[a-f0-9]+$/i.test(value)) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, 'hex'));
}
