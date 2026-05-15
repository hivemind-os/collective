import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EncryptedBlobStore,
  FilesystemBlobStore,
  generateX25519KeyPair,
  parseEncryptedPayload,
} from '../../src/index.js';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

async function createBaseDir(): Promise<string> {
  const baseDir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(baseDir);
  await mkdir(baseDir, { recursive: true });
  return baseDir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('EncryptedBlobStore', () => {
  it('stores encrypted data and fetches decrypted plaintext', async () => {
    const inner = new FilesystemBlobStore(await createBaseDir());
    const sender = new EncryptedBlobStore(inner, generateX25519KeyPair());
    const recipientKeys = generateX25519KeyPair();
    const recipient = new EncryptedBlobStore(inner, recipientKeys);
    const data = encoder.encode('private payload');

    const stored = await sender.storeEncrypted(data, recipientKeys.publicKey);
    const decrypted = await recipient.fetchDecrypted(stored.blobId);

    expect(Buffer.from(decrypted ?? [])).toEqual(Buffer.from(data));
  });

  it('stores ciphertext instead of plaintext', async () => {
    const inner = new FilesystemBlobStore(await createBaseDir());
    const sender = new EncryptedBlobStore(inner, generateX25519KeyPair());
    const recipient = generateX25519KeyPair();
    const plaintext = encoder.encode('ciphertext check');

    const stored = await sender.storeEncrypted(plaintext, recipient.publicKey);
    const raw = await sender.fetch(stored.blobId);

    expect(Buffer.from(raw ?? [])).not.toEqual(Buffer.from(plaintext));
    expect(parseEncryptedPayload(raw ?? new Uint8Array())).not.toBeNull();
  });

  it('keeps the regular blobstore interface unencrypted for compatibility', async () => {
    const inner = new FilesystemBlobStore(await createBaseDir());
    const store = new EncryptedBlobStore(inner, generateX25519KeyPair());
    const plaintext = encoder.encode('plain compatibility');

    const stored = await store.store(plaintext);
    const fetched = await store.fetch(stored.blobId);
    const decrypted = await store.fetchDecrypted(stored.blobId);

    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(plaintext));
    expect(Buffer.from(decrypted ?? [])).toEqual(Buffer.from(plaintext));
  });

  it('fails to decrypt with the wrong recipient key', async () => {
    const inner = new FilesystemBlobStore(await createBaseDir());
    const sender = new EncryptedBlobStore(inner, generateX25519KeyPair());
    const recipient = generateX25519KeyPair();
    const outsider = new EncryptedBlobStore(inner, generateX25519KeyPair());

    const stored = await sender.storeEncrypted(encoder.encode('recipient only'), recipient.publicKey);

    await expect(outsider.fetchDecrypted(stored.blobId)).rejects.toBeInstanceOf(Error);
  });
});
