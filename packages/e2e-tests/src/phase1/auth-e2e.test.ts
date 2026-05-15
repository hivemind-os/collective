import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Ed25519AuthProvider,
  ZkLoginProvider,
  ZkLoginSessionStore,
  createPkcePair,
  deriveEvmKey,
  parseDID,
  pollDeviceFlow,
  startDeviceFlow,
} from '@agentic-mesh/core';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { jwtToAddress } from '@mysten/sui/zklogin';
import { afterAll, describe, expect, it } from 'vitest';

import { MockOidcProvider, PortAllocator } from '../harness/index.js';
import { createArtifactDir, createArtifactRoot, removeDirectoryWithRetries } from './test-helpers.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secp256k1Order = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

let artifactRoot: string;

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
});

describe('Phase 1 Beta E2E: Auth and identity', () => {
  it('creates an Ed25519 DID, signs a message, and verifies the signature end-to-end', async () => {
    artifactRoot ??= await createArtifactRoot('auth-e2e');
    const keypair = Ed25519Keypair.generate();
    const provider = new Ed25519AuthProvider(keypair);
    const message = encoder.encode('phase1-beta-auth-message');

    const signed = await provider.signPersonalMessage(message);
    const did = provider.getDID();
    const parsedDid = parseDID(did);
    const verified = await keypair.getPublicKey().verifyPersonalMessage(message, decoder.decode(signed.signature));

    expect(did).toMatch(/^did:mesh:/);
    expect(Buffer.from(parsedDid.publicKey)).toEqual(Buffer.from(keypair.getPublicKey().toRawBytes()));
    expect(verified).toBe(true);
  });

  it('produces different DIDs for different Ed25519 providers', () => {
    const first = new Ed25519AuthProvider(Ed25519Keypair.generate());
    const second = new Ed25519AuthProvider(Ed25519Keypair.generate());

    expect(first.getDID()).not.toBe(second.getDID());
  });

  it('signs transaction bytes with Ed25519 and verifies the transaction signature', async () => {
    const keypair = Ed25519Keypair.generate();
    const provider = new Ed25519AuthProvider(keypair);
    const transactionBytes = randomBytes(64);

    const signature = await provider.signTransaction(transactionBytes);
    const verified = await keypair.getPublicKey().verifyTransaction(transactionBytes, decoder.decode(signature));

    expect(verified).toBe(true);
  });

  it('runs the zkLogin OAuth exchange against the mock OIDC provider and derives a deterministic address', async () => {
    artifactRoot ??= await createArtifactRoot('auth-e2e');
    const sessionDir = await createArtifactDir(artifactRoot, 'zklogin-session');
    const { provider, cleanup, session, tokens } = await completeMockZkLogin(sessionDir);

    try {
      const deterministicAddress = jwtToAddress(tokens.jwt, session.salt);

      expect(provider.isAuthenticated()).toBe(true);
      expect(session.salt).toBe('123456');
      expect(session.address).toBe(deterministicAddress);
      expect(jwtToAddress(tokens.jwt, session.salt)).toBe(deterministicAddress);
      expect(provider.getDID()).toBe(`did:mesh:zklogin:${deterministicAddress}`);
    } finally {
      await cleanup();
    }
  });

  it('stores and reloads encrypted zkLogin sessions without leaking plaintext secrets', async () => {
    artifactRoot ??= await createArtifactRoot('auth-e2e');
    const sessionDir = await createArtifactDir(artifactRoot, 'session-store-roundtrip');
    const store = new ZkLoginSessionStore(sessionDir, new Uint8Array([1, 2, 3, 4]));
    const session = createStoredSession();

    await store.save(session);
    const loaded = await store.loadLatest();
    const files = await readdir(sessionDir);
    const fileContents = await readFile(join(sessionDir, files[0] ?? ''), 'utf8');

    expect(loaded).toMatchObject({
      jwt: session.jwt,
      salt: session.salt,
      address: session.address,
      sub: session.sub,
      iss: session.iss,
      aud: session.aud,
      maxEpoch: session.maxEpoch,
    });
    expect(loaded?.ephemeralKeypair.getSecretKey()).toBe(session.ephemeralKeypair.getSecretKey());
    expect(fileContents).not.toContain(session.jwt);
    expect(fileContents).not.toContain(session.refreshToken ?? '');
  });

  it('detects expired zkLogin sessions and removes them from disk', async () => {
    artifactRoot ??= await createArtifactRoot('auth-e2e');
    const sessionDir = await createArtifactDir(artifactRoot, 'session-store-expiry');
    const store = new ZkLoginSessionStore(sessionDir, new Uint8Array([4, 3, 2, 1]));
    const session = createStoredSession({ maxEpoch: 4 });

    await store.save(session);

    expect(store.isExpired(session, 4)).toBe(true);
    expect(await store.loadLatestValid(4)).toBeNull();

    await store.deleteExpired(4);
    expect(await store.loadLatest()).toBeNull();
  });

  it('preserves multiple zkLogin sessions with different identities', async () => {
    artifactRoot ??= await createArtifactRoot('auth-e2e');
    const sessionDir = await createArtifactDir(artifactRoot, 'session-store-multiple');
    const store = new ZkLoginSessionStore(sessionDir, new Uint8Array([9, 8, 7, 6]));
    const first = createStoredSession({ sub: 'alpha-user', address: '0xalpha', updatedAt: 10 });
    const second = createStoredSession({ sub: 'beta-user', address: '0xbeta', updatedAt: 20 });

    await store.save(first);
    await store.save(second);

    const loaded = await store.loadAll();
    const latest = await store.loadLatest();

    expect(loaded).toHaveLength(2);
    expect(new Set(loaded.map((entry) => entry.sub))).toEqual(new Set(['alpha-user', 'beta-user']));
    expect(latest?.sub).toBe('beta-user');
  });

  it('derives deterministic EVM keys and changes them when salt or subject changes', () => {
    const identityKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
    const first = deriveEvmKey(identityKey, 'salt-a', 'subject-a');
    const second = deriveEvmKey(identityKey, 'salt-a', 'subject-a');
    const differentSalt = deriveEvmKey(identityKey, 'salt-b', 'subject-a');
    const differentSub = deriveEvmKey(identityKey, 'salt-a', 'subject-b');
    const scalar = BigInt(`0x${Buffer.from(first).toString('hex')}`);

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
    expect(Buffer.from(differentSalt)).not.toEqual(Buffer.from(first));
    expect(Buffer.from(differentSub)).not.toEqual(Buffer.from(first));
    expect(first).toHaveLength(32);
    expect(scalar).toBeGreaterThan(0n);
    expect(scalar).toBeLessThan(secp256k1Order);
  });

  it('starts the OAuth device flow and completes polling after approval', async () => {
    const portAllocator = new PortAllocator();
    const [oidcPort] = await portAllocator.allocate(1);
    const oidc = new MockOidcProvider();

    try {
      await oidc.start(oidcPort);
      const deviceFlow = await startDeviceFlow(oidc.oauthConfig);

      expect(deviceFlow.userCode).toBe('MOCK-CODE');
      expect(deviceFlow.verificationUri).toBe(`${oidc.oauthConfig.deviceCodeEndpoint?.replace('/device/code', '')}/verify`);
      expect(await pollDeviceFlow(deviceFlow.deviceCode, oidc.oauthConfig)).toBeNull();

      oidc.approveDeviceCode(deviceFlow.deviceCode);
      await expect(pollDeviceFlow(deviceFlow.deviceCode, oidc.oauthConfig)).resolves.toMatchObject({
        jwt: expect.any(String),
        refreshToken: 'mock-refresh-token',
      });
    } finally {
      await oidc.stop();
      await portAllocator.release([oidcPort]);
    }
  });
});

async function completeMockZkLogin(sessionDir: string): Promise<{
  provider: ZkLoginProvider;
  session: Awaited<ReturnType<ZkLoginProvider['authenticateWithJwt']>>;
  tokens: Awaited<ReturnType<ZkLoginProvider['exchangeAuthorizationCode']>>;
  cleanup: () => Promise<void>;
}> {
  const portAllocator = new PortAllocator();
  const [oidcPort] = await portAllocator.allocate(1);
  const oidc = new MockOidcProvider({ aud: 'mock-client-id', sub: 'mesh-user' });
  await oidc.start(oidcPort);

  const provider = new ZkLoginProvider({
    client: {
      getCurrentEpoch: async () => ({ epoch: '7' } as Awaited<ReturnType<SuiClient['getCurrentEpoch']>>),
    },
    oauth: {
      ...oidc.oauthConfig,
      redirectUri: 'http://127.0.0.1/mock/callback',
    },
    sessionStore: new ZkLoginSessionStore(sessionDir, new Uint8Array([7, 7, 7, 7])),
  });

  try {
    const { verifier, challenge } = createPkcePair();
    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: 'http://127.0.0.1/mock/callback',
      state: 'auth-state',
      codeChallenge: challenge,
    });
    const authorizationRedirect = await fetch(authRequest.authorizationUrl, { redirect: 'manual' });
    const callbackUrl = authorizationRedirect.headers.get('location');
    const authorizationCode = callbackUrl ? new URL(callbackUrl).searchParams.get('code') : null;
    if (!authorizationCode) {
      throw new Error('Mock OIDC did not return an authorization code.');
    }

    const tokens = await provider.exchangeAuthorizationCode(
      authorizationCode,
      verifier,
      'http://127.0.0.1/mock/callback',
    );
    const session = await provider.authenticateWithJwt(tokens.jwt, {
      pendingSession: authRequest.pendingSession,
      refreshToken: tokens.refreshToken,
    });

    return {
      provider,
      session,
      tokens,
      cleanup: async () => {
        await oidc.stop();
        await portAllocator.release([oidcPort]);
      },
    };
  } catch (error) {
    await oidc.stop();
    await portAllocator.release([oidcPort]);
    throw error;
  }
}

function createStoredSession(overrides: Partial<Awaited<ReturnType<ZkLoginProvider['authenticateWithJwt']>>> = {}) {
  return {
    jwt: 'header.payload.signature',
    salt: '123456',
    epoch: 9,
    ephemeralKeypair: Ed25519Keypair.generate(),
    proof: {
      proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
      issBase64Details: { value: 'issuer', indexMod4: 0 },
      headerBase64: 'header',
      addressSeed: createHash('sha256').update('seed').digest('hex'),
    },
    maxEpoch: 12,
    address: '0x1234',
    sub: 'subject-1',
    iss: 'https://accounts.google.com',
    aud: 'mock-client-id',
    randomness: '987654321',
    refreshToken: 'refresh-token',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
