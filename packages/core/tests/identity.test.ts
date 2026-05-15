import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDID,
  generateKeypair,
  isValidDID,
  loadOrCreateKeypair,
  parseDID,
  sign,
  verify,
} from '../src/index.js';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDataDir(): Promise<string> {
  const dataDir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dataDir);
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

describe('identity', () => {
  it('generates a keypair with a 32-byte public key', () => {
    const keypair = generateKeypair();
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  it('loads or creates a persisted keypair', async () => {
    const dataDir = await createDataDir();

    const first = loadOrCreateKeypair(dataDir);
    const second = loadOrCreateKeypair(dataDir);

    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(Buffer.from(second.publicKey)).toEqual(Buffer.from(first.publicKey));
  });

  it('creates and parses DIDs', () => {
    const keypair = generateKeypair();
    const did = createDID(keypair.publicKey);
    const parsed = parseDID(did);

    expect(did).toMatch(/^did:mesh:/);
    expect(Buffer.from(parsed.publicKey)).toEqual(Buffer.from(keypair.publicKey));
  });

  it('signs and verifies messages', () => {
    const keypair = generateKeypair();
    const message = encoder.encode('agentic mesh');
    const signature = sign(message, keypair.secretKey);

    expect(verify(message, signature, keypair.publicKey)).toBe(true);
    expect(verify(encoder.encode('tampered'), signature, keypair.publicKey)).toBe(false);
  });

  it('rejects invalid DID formats', () => {
    expect(isValidDID('did:other:abc')).toBe(false);
    expect(() => parseDID('did:mesh:')).toThrow();
  });
});
