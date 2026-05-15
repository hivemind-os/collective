import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZkLoginProvider } from '@agentic-mesh/core';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { PortalServer } from '../src/portal/server.js';

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

async function startMockOidc(): Promise<{ server: FastifyInstance; baseUrl: string }> {
  const codes = new Map<string, { nonce: string; clientId: string }>();
  const server = Fastify({ logger: false });
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  server.get('/auth', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const code = `code-${randomUUID()}`;
    codes.set(code, {
      nonce: query.nonce ?? '',
      clientId: query.client_id ?? '',
    });
    reply.redirect(`${query.redirect_uri}?code=${code}&state=${query.state}`);
  });

  server.post('/token', async (request) => {
    const params = request.body as Record<string, string>;
    const code = codes.get(params.code ?? '');
    if (!code) {
      return { error: 'invalid_grant' };
    }

    return {
      access_token: 'access-token',
      id_token: createJwt({
        iss: 'https://accounts.google.com',
        aud: code.clientId,
        sub: 'portal-user',
        nonce: code.nonce,
      }),
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    };
  });

  server.post('/get_salt', async () => ({ salt: '123456' }));
  server.post('/v1', async () => ({
    proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
    issBase64Details: { value: 'issuer', indexMod4: 1 },
    headerBase64: 'header',
  }));

  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  return { server, baseUrl: typeof baseUrl === 'string' ? baseUrl : `http://127.0.0.1:${baseUrl.port}` };
}

describe('portal server', () => {
  it('serves the auth flow and updates setup state', async () => {
    const dir = await createTestDir();
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const config: DaemonFullConfig = {
      ...defaults,
      daemon: {
        ...defaults.daemon,
        dataDir: resolve(dir, 'daemon'),
        pidFile: resolve(dir, 'daemon.pid'),
      },
      auth: {
        mode: 'zklogin',
        google: {
          clientId: 'portal-client-id',
        },
        portal: {
          port: 0,
        },
      },
    };
    const authProvider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '7' }),
      },
      oauth: {
        provider: 'google',
        clientId: config.auth.google?.clientId ?? '',
        redirectUri: '',
        authorizationEndpoint: `${baseUrl}/auth`,
        tokenEndpoint: `${baseUrl}/token`,
        saltEndpoint: `${baseUrl}/get_salt`,
        proverEndpoint: `${baseUrl}/v1`,
      },
    });
    const portal = new PortalServer({ config, authProvider });
    const portalUrl = await portal.start();

    const landing = await fetch(portalUrl);
    expect(await landing.text()).toContain('Welcome to Agentic Mesh');

    const authRedirect = await fetch(`${portalUrl}/auth/google`, { redirect: 'manual' });
    expect(authRedirect.status).toBe(302);
    const providerRedirect = authRedirect.headers.get('location');
    expect(providerRedirect).toContain(`${baseUrl}/auth`);

    const callbackRedirect = await fetch(providerRedirect ?? '', { redirect: 'manual' });
    expect(callbackRedirect.status).toBe(302);
    const callbackUrl = callbackRedirect.headers.get('location');
    expect(callbackUrl).toContain('/auth/callback');

    const callbackPage = await fetch(callbackUrl ?? '');
    expect(await callbackPage.text()).toContain('Finish setup');

    const beforeFinish = await fetch(`${portalUrl}/api/status`);
    const beforeFinishBody = (await beforeFinish.json()) as Record<string, unknown>;
    expect(beforeFinishBody.authenticated).toBe(true);
    expect(beforeFinishBody.setupComplete).toBe(false);

    const finish = await fetch(`${portalUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyLimitSui: '5' }),
    });
    expect(finish.ok).toBe(true);

    await portal.waitForAuth();

    const afterFinish = await fetch(`${portalUrl}/api/status`);
    const afterFinishBody = (await afterFinish.json()) as Record<string, unknown>;
    expect(afterFinishBody.authenticated).toBe(true);
    expect(afterFinishBody.setupComplete).toBe(true);
    expect(afterFinishBody.spendingLimitMist).toBe('5000000000');

    await portal.stop();
    await mockOidc.close();
  });

  it('handles oauth denial and clears the pending PKCE verifier', async () => {
    const dir = await createTestDir();
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const config: DaemonFullConfig = {
      ...defaults,
      daemon: {
        ...defaults.daemon,
        dataDir: resolve(dir, 'daemon'),
        pidFile: resolve(dir, 'daemon.pid'),
      },
      auth: {
        mode: 'zklogin',
        google: {
          clientId: 'portal-client-id',
        },
        portal: {
          port: 0,
        },
      },
    };
    const authProvider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '7' }),
      },
      oauth: {
        provider: 'google',
        clientId: config.auth.google?.clientId ?? '',
        redirectUri: '',
        authorizationEndpoint: `${baseUrl}/auth`,
        tokenEndpoint: `${baseUrl}/token`,
        saltEndpoint: `${baseUrl}/get_salt`,
        proverEndpoint: `${baseUrl}/v1`,
      },
    });
    const portal = new PortalServer({ config, authProvider });
    const portalUrl = await portal.start();

    const authRedirect = await fetch(`${portalUrl}/auth/google`, { redirect: 'manual' });
    const providerRedirect = authRedirect.headers.get('location');
    const state = providerRedirect ? new URL(providerRedirect).searchParams.get('state') : null;

    const denied = await fetch(`${portalUrl}/auth/callback?error=access_denied&state=${state ?? ''}`);
    expect(await denied.text()).toContain('access denied');

    const reusedState = await fetch(`${portalUrl}/auth/callback?code=unused&state=${state ?? ''}`);
    expect(await reusedState.text()).toContain('Unknown login state.');

    await portal.stop();
    await mockOidc.close();
  });
});
