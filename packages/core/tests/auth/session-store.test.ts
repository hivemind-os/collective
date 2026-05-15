import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, describe, expect, it } from 'vitest';

import { ZkLoginSessionStore } from '../../src/auth/session-store.js';
import type { StoredZkLoginSession } from '../../src/auth/types.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createSession(overrides: Partial<StoredZkLoginSession> = {}): StoredZkLoginSession {
  return {
    jwt: 'header.payload.signature',
    salt: '12345',
    epoch: 10,
    ephemeralKeypair: Ed25519Keypair.generate(),
    proof: {
      proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
      issBase64Details: { value: 'issuer', indexMod4: 0 },
      headerBase64: 'header',
      addressSeed: '98765',
    },
    maxEpoch: 12,
    address: '0x123',
    sub: 'subject-1',
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    randomness: '999',
    refreshToken: 'refresh-token',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function getOnlySessionFile(dir: string): Promise<string> {
  const entries = await readdir(dir);
  const sessionFile = entries.find((entry) => entry.endsWith('.json'));
  if (!sessionFile) {
    throw new Error('Expected a persisted session file.');
  }

  return join(dir, sessionFile);
}

async function writeLegacySession(dir: string, encryptionKey: Uint8Array, session: StoredZkLoginSession): Promise<void> {
  const key = createHash('sha256').update(Buffer.from(encryptionKey)).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({
    ...session,
    ephemeralSecretKey: session.ephemeralKeypair.getSecretKey(),
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const filename = `${createHash('sha256').update(`${session.iss}:${session.sub}`).digest('hex')}.json`;

  await writeFile(
    join(dir, filename),
    JSON.stringify({
      version: 1,
      metadata: {
        address: session.address,
        iss: session.iss,
        sub: session.sub,
        maxEpoch: session.maxEpoch,
        updatedAt: session.updatedAt,
      },
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
    'utf8',
  );
}

describe('ZkLoginSessionStore', () => {
  it('stores and loads encrypted sessions without leaking sensitive metadata', async () => {
    const dir = await createTestDir();
    const encryptionKey = new Uint8Array([1, 2, 3, 4]);
    const store = new ZkLoginSessionStore(dir, encryptionKey);
    const session = createSession();

    await store.save(session);

    const raw = await readFile(await getOnlySessionFile(dir), 'utf8');
    const envelope = JSON.parse(raw) as { version: number; metadata: Record<string, unknown> };
    const loaded = await store.loadLatest();

    expect(envelope.version).toBe(2);
    expect(envelope.metadata).toEqual({ maxEpoch: session.maxEpoch, updatedAt: session.updatedAt });
    expect(raw).not.toContain(session.address);
    expect(raw).not.toContain(session.sub);
    expect(raw).not.toContain(session.refreshToken ?? '');
    expect(loaded?.address).toBe(session.address);
    expect(loaded?.refreshToken).toBe(session.refreshToken);
    expect(loaded?.ephemeralKeypair.getSecretKey()).toBe(session.ephemeralKeypair.getSecretKey());
  });

  it('loads legacy version 1 session envelopes', async () => {
    const dir = await createTestDir();
    const encryptionKey = new Uint8Array([9, 8, 7, 6]);
    const store = new ZkLoginSessionStore(dir, encryptionKey);
    const session = createSession({ sub: 'legacy-user' });

    await writeLegacySession(dir, encryptionKey, session);

    await expect(store.loadLatest()).resolves.toMatchObject({
      address: session.address,
      sub: session.sub,
      refreshToken: session.refreshToken,
    });
  });

  it('filters expired sessions and refreshes near-expiry sessions', async () => {
    const dir = await createTestDir();
    const store = new ZkLoginSessionStore(dir, new Uint8Array([4, 3, 2, 1]));
    const session = createSession();

    await store.save(session);
    expect(await store.loadLatestValid(11)).not.toBeNull();
    expect(await store.refreshIfNeeded(11, async (current) => ({ ...current, maxEpoch: 20, updatedAt: 3 }))).toMatchObject({
      maxEpoch: 20,
    });

    await store.deleteExpired(20);
    expect(await store.loadLatest()).toBeNull();
  });
});
