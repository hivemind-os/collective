import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { jwtToAddress } from '@mysten/sui/zklogin';

import { ZkLoginSessionStore } from '../../src/auth/session-store.js';
import { SessionState } from '../../src/auth/session-state.js';
import { ZkLoginProvider } from '../../src/auth/zklogin-provider.js';
import type { OAuthConfig } from '../../src/auth/types.js';

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

function createJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createFetchFn(options: { failRefresh?: boolean } = {}): typeof fetch {
  return vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('get_salt')) {
      return new Response(JSON.stringify({ salt: '123456' }));
    }

    if (url.includes('/v1')) {
      return new Response(
        JSON.stringify({
          proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
          issBase64Details: { value: 'issuer', indexMod4: 1 },
          headerBase64: 'header',
        }),
      );
    }

    if (url.includes('/token')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (body.get('grant_type') === 'refresh_token' && options.failRefresh) {
        return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503, statusText: 'Unavailable' });
      }

      return new Response(JSON.stringify({
        id_token: createJwt({
          iss: 'https://accounts.google.com',
          aud: 'google-client-id',
          sub: 'test-subject',
          nonce: body.get('nonce') ?? 'refresh-nonce',
          exp: Math.floor(Date.now() / 1_000) + 3600,
        }),
        refresh_token: 'refresh-token-2',
      }));
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

describe('ZkLoginProvider', () => {
  it('creates an auth request, authenticates a session, and signs with zkLogin', async () => {
    const oauth: OAuthConfig = {
      provider: 'google',
      clientId: 'google-client-id',
      redirectUri: 'http://127.0.0.1:3000/auth/callback',
      authorizationEndpoint: 'https://accounts.example/auth',
      tokenEndpoint: 'https://accounts.example/token',
      saltEndpoint: 'https://salt.example/get_salt',
      proverEndpoint: 'https://prover.example/v1',
    };
    const client = {
      getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '42' }),
    };
    const fetchFn: typeof fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('get_salt')) {
        return new Response(JSON.stringify({ salt: '123456' }));
      }

      if (url.includes('/v1')) {
        return new Response(
          JSON.stringify({
            proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
            issBase64Details: { value: 'issuer', indexMod4: 1 },
            headerBase64: 'header',
          }),
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const provider = new ZkLoginProvider({ client, oauth, fetchFn });

    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: oauth.redirectUri,
      state: 'portal-state',
      codeChallenge: 'pkce-challenge',
    });

    expect(authRequest.authorizationUrl).toContain('code_challenge=pkce-challenge');
    expect(authRequest.authorizationUrl).toContain('state=portal-state');
    expect(authRequest.pendingSession.maxEpoch).toBe(44);

    const jwt = createJwt({
      iss: 'https://accounts.google.com',
      aud: oauth.clientId,
      sub: 'test-subject',
      email: 'mesh@example.com',
      nonce: authRequest.pendingSession.nonce,
    });
    const session = await provider.authenticateWithJwt(jwt, {
      pendingSession: authRequest.pendingSession,
      refreshToken: 'refresh-token',
    });

    expect(provider.isAuthenticated()).toBe(true);
    await expect(provider.isSessionValid?.()).resolves.toBe(true);
    expect(provider.getSessionState()).toBe(SessionState.VALID);
    expect(await provider.getAddress()).toBe(jwtToAddress(jwt, session.salt));
    expect(provider.getDID()).toBe(`did:mesh:zklogin:${session.address}`);
    expect(provider.getSession()?.provider).toBe('google');
    expect(provider.getSession()?.refreshToken).toBe('refresh-token');
    expect(provider.toSuiSigner().toSuiAddress()).toBe(session.address);

    const signedTransaction = await provider.signTransaction(new Uint8Array([1, 2, 3]));
    const signedMessage = await provider.signPersonalMessage(new Uint8Array([4, 5, 6]));

    expect(signedTransaction.length).toBeGreaterThan(0);
    expect(signedMessage.signature.length).toBeGreaterThan(0);
    expect(provider.getPublicKey().length).toBeGreaterThan(0);
  });

  it('uses Apple-specific authorization parameters when requested', async () => {
    const provider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '42' }),
      },
      oauth: {
        provider: 'apple',
        clientId: 'apple-client-id',
        redirectUri: 'http://127.0.0.1:3000/auth/apple/callback',
        authorizationEndpoint: 'https://appleid.example/auth',
        tokenEndpoint: 'https://appleid.example/token',
        saltEndpoint: 'https://salt.example/get_salt',
        proverEndpoint: 'https://prover.example/v1',
      },
      fetchFn: vi.fn() as typeof fetch,
    });

    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: 'http://127.0.0.1:3000/auth/apple/callback',
      state: 'apple-state',
      codeChallenge: 'apple-challenge',
      scopes: ['name', 'email'],
    });
    const authorizationUrl = new URL(authRequest.authorizationUrl);

    expect(authorizationUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code id_token');
    expect(authorizationUrl.searchParams.get('scope')).toBe('name email');
    expect(authorizationUrl.searchParams.get('nonce')).toBe(authRequest.pendingSession.nonce);
  });

  it('throws SessionExpiredError after refresh retries are exhausted', async () => {
    const dir = await createTestDir();
    const sleep = vi.fn(async () => undefined);
    const client = {
      getCurrentEpoch: vi
        .fn()
        .mockResolvedValueOnce({ epoch: '41' })
        .mockResolvedValue({ epoch: '42' }),
    };
    const oauth: OAuthConfig = {
      provider: 'google',
      clientId: 'google-client-id',
      redirectUri: 'http://127.0.0.1:3000/auth/callback',
      authorizationEndpoint: 'https://accounts.example/auth',
      tokenEndpoint: 'https://accounts.example/token',
      saltEndpoint: 'https://salt.example/get_salt',
      proverEndpoint: 'https://prover.example/v1',
    };
    const sessionStore = new ZkLoginSessionStore(resolve(dir, 'sessions'), new Uint8Array([1, 9, 9, 1]), { sleep });
    const provider = new ZkLoginProvider({
      client,
      oauth,
      fetchFn: createFetchFn({ failRefresh: true }),
      sessionStore,
    });
    const sessionStates: SessionState[] = [];
    provider.onSessionStateChange((event) => {
      sessionStates.push(event.currentState);
    });

    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: oauth.redirectUri,
      state: 'refresh-state',
      codeChallenge: 'refresh-challenge',
    });
    const jwt = createJwt({
      iss: 'https://accounts.google.com',
      aud: oauth.clientId,
      sub: 'test-subject',
      nonce: authRequest.pendingSession.nonce,
      exp: Math.floor(Date.now() / 1_000) + 60,
    });
    await provider.authenticateWithJwt(jwt, {
      pendingSession: authRequest.pendingSession,
      refreshToken: 'refresh-token',
    });

    await expect(provider.restoreSession()).rejects.toMatchObject({ name: 'SessionExpiredError' });

    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getSession()).toBeNull();
    expect(provider.getSessionState()).toBe(SessionState.NEEDS_REAUTH);
    expect(await provider.isSessionValid?.()).toBe(false);
    expect(sessionStates).toContain(SessionState.REFRESHING);
    expect(sessionStates.at(-1)).toBe(SessionState.NEEDS_REAUTH);
  });

  it('treats expired sessions as unauthenticated and surfaces SessionExpiredError', async () => {
    const oauth: OAuthConfig = {
      provider: 'google',
      clientId: 'google-client-id',
      redirectUri: 'http://127.0.0.1:3000/auth/callback',
      authorizationEndpoint: 'https://accounts.example/auth',
      tokenEndpoint: 'https://accounts.example/token',
      saltEndpoint: 'https://salt.example/get_salt',
      proverEndpoint: 'https://prover.example/v1',
    };
    const provider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '42' }),
      },
      oauth,
      fetchFn: vi.fn(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('get_salt')) {
          return new Response(JSON.stringify({ salt: '123456' }));
        }

        if (url.includes('/v1')) {
          return new Response(
            JSON.stringify({
              proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
              issBase64Details: { value: 'issuer', indexMod4: 1 },
              headerBase64: 'header',
            }),
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });
    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: oauth.redirectUri,
      state: 'portal-state',
      codeChallenge: 'pkce-challenge',
    });

    await provider.authenticateWithJwt(
      createJwt({
        iss: 'https://accounts.google.com',
        aud: oauth.clientId,
        sub: 'test-subject',
        nonce: authRequest.pendingSession.nonce,
        exp: Math.floor(Date.now() / 1_000) - 60,
      }),
      { pendingSession: authRequest.pendingSession },
    );

    expect(provider.isAuthenticated()).toBe(false);
    await expect(provider.getAddress()).rejects.toMatchObject({ name: 'SessionExpiredError' });
  });

  it('rejects JWTs with mismatched issuer, audience, or nonce claims', async () => {
    const oauth: OAuthConfig = {
      provider: 'google',
      clientId: 'google-client-id',
      redirectUri: 'http://127.0.0.1:3000/auth/callback',
      authorizationEndpoint: 'https://accounts.example/auth',
      tokenEndpoint: 'https://accounts.example/token',
      saltEndpoint: 'https://salt.example/get_salt',
      proverEndpoint: 'https://prover.example/v1',
    };
    const provider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '42' }),
      },
      oauth,
      fetchFn: vi.fn(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('get_salt')) {
          return new Response(JSON.stringify({ salt: '123456' }));
        }

        if (url.includes('/v1')) {
          return new Response(
            JSON.stringify({
              proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
              issBase64Details: { value: 'issuer', indexMod4: 1 },
              headerBase64: 'header',
            }),
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });
    const authRequest = await provider.createAuthorizationRequest({
      redirectUri: oauth.redirectUri,
      state: 'portal-state',
      codeChallenge: 'pkce-challenge',
    });

    await expect(
      provider.authenticateWithJwt(
        createJwt({
          iss: 'https://issuer.example',
          aud: oauth.clientId,
          sub: 'test-subject',
          nonce: authRequest.pendingSession.nonce,
        }),
        { pendingSession: authRequest.pendingSession },
      ),
    ).rejects.toThrow('OAuth token issuer mismatch.');

    await expect(
      provider.authenticateWithJwt(
        createJwt({
          iss: 'https://accounts.google.com',
          aud: 'someone-else',
          sub: 'test-subject',
          nonce: authRequest.pendingSession.nonce,
        }),
        { pendingSession: authRequest.pendingSession },
      ),
    ).rejects.toThrow('OAuth token audience mismatch.');

    await expect(
      provider.authenticateWithJwt(
        createJwt({
          iss: 'https://accounts.google.com',
          aud: oauth.clientId,
          sub: 'test-subject',
          nonce: 'unexpected-nonce',
        }),
        { pendingSession: authRequest.pendingSession },
      ),
    ).rejects.toThrow('OAuth token nonce mismatch.');
  });
});
