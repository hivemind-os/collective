export interface ContentAddressedBlob {
  blobId: string;
  contentHash: string;
  size: number;
  storedAt: number;
}

export interface StoredBlob extends ContentAddressedBlob {
  hash: string;
  checksum: string;
}

export type BlobMetadata = ContentAddressedBlob;

export class BlobIntegrityError extends Error {
  constructor(
    message: string,
    readonly blobId: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(message);
    this.name = 'BlobIntegrityError';
  }
}

export interface BlobStore {
  store(data: Uint8Array): Promise<StoredBlob>;
  fetch(blobId: string): Promise<Uint8Array | null>;
  exists(blobId: string): Promise<boolean>;
  delete(blobId: string): Promise<void>;
  getMetadata?(blobId: string): Promise<BlobMetadata | null>;
}
