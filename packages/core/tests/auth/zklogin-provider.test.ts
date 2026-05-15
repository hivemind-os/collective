import { describe, expect, it, vi } from 'vitest';

import { jwtToAddress } from '@mysten/sui/zklogin';

import { ZkLoginProvider } from '../../src/auth/zklogin-provider.js';
import type { OAuthConfig } from '../../src/auth/types.js';

function createJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
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
    expect(await provider.getAddress()).toBe(jwtToAddress(jwt, session.salt));
    expect(provider.getDID()).toBe(`did:mesh:zklogin:${session.address}`);
    expect(provider.getSession()?.refreshToken).toBe('refresh-token');
    expect(provider.toSuiSigner().toSuiAddress()).toBe(session.address);

    const signedTransaction = await provider.signTransaction(new Uint8Array([1, 2, 3]));
    const signedMessage = await provider.signPersonalMessage(new Uint8Array([4, 5, 6]));

    expect(signedTransaction.length).toBeGreaterThan(0);
    expect(signedMessage.signature.length).toBeGreaterThan(0);
    expect(provider.getPublicKey().length).toBeGreaterThan(0);
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
