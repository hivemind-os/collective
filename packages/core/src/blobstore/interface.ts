export interface BlobStore {
  store(data: Uint8Array): Promise<{ blobId: string; checksum: string }>;
  fetch(blobId: string): Promise<Uint8Array | null>;
  exists(blobId: string): Promise<boolean>;
  delete(blobId: string): Promise<void>;
}
