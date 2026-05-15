import type { BlobMetadata, BlobStore, StoredBlob } from './interface.js';
import { decryptFromSender, encryptForRecipient, parseEncryptedPayload, serializeEncryptedPayload } from '../crypto/encryption.js';
import type { X25519KeyPair } from '../crypto/x25519.js';

export class EncryptedBlobStore implements BlobStore {
  constructor(
    private readonly inner: BlobStore,
    private readonly myKeyPair: X25519KeyPair,
  ) {}

  async storeEncrypted(
    data: Uint8Array,
    recipientPublicKey: Uint8Array,
  ): Promise<{ blobId: string; hash: string }> {
    const payload = await encryptForRecipient(data, this.myKeyPair.privateKey, recipientPublicKey);
    const stored = await this.inner.store(serializeEncryptedPayload(payload));
    return {
      blobId: stored.blobId,
      hash: stored.hash,
    };
  }

  async fetchDecrypted(blobId: string): Promise<Uint8Array | null> {
    const data = await this.inner.fetch(blobId);
    if (!data) {
      return null;
    }

    const payload = parseEncryptedPayload(data);
    if (!payload) {
      return data;
    }

    return await decryptFromSender(payload, this.myKeyPair.privateKey);
  }

  async store(data: Uint8Array): Promise<StoredBlob> {
    return await this.inner.store(data);
  }

  async fetch(blobId: string): Promise<Uint8Array | null> {
    return await this.inner.fetch(blobId);
  }

  async exists(blobId: string): Promise<boolean> {
    return await this.inner.exists(blobId);
  }

  async delete(blobId: string): Promise<void> {
    await this.inner.delete(blobId);
  }

  async getMetadata(blobId: string): Promise<BlobMetadata | null> {
    return await this.inner.getMetadata?.(blobId) ?? null;
  }
}
