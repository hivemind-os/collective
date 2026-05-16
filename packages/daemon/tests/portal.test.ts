import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZkLoginProvider } from '@agentic-mesh/core';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig, loadConfig } from '../src/config.js';
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

async function writePortalConfigFile(
  configPath: string,
  dir: string,
  auth: { googleClientId?: string; appleClientId?: string },
): Promise<void> {
  await writeFile(
    configPath,
    [
      'auth:',
      '  mode: zklogin',
      ...(auth.googleClientId ? ['  google:', `    clientId: ${auth.googleClientId}`] : []),
      ...(auth.appleClientId ? ['  apple:', `    clientId: ${auth.appleClientId}`] : []),
      '  portal:',
      '    port: 0',
      'daemon:',
      `  dataDir: ${resolve(dir, 'daemon')}`,
      `  pidFile: ${resolve(dir, 'daemon.pid')}`,
    ].join('\n'),
    'utf8',
  );
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
  it('serves the auth flow, persists settings, and reloads them on startup', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const initialConfig: DaemonFullConfig = {
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
    await writePortalConfigFile(configPath, dir, { googleClientId: 'portal-client-id' });
    const config = initialConfig;
    const logger = { info: vi.fn(), warn: vi.fn() };
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
    const portal = new PortalServer({ config, configPath, authProvider, logger });
    const portalUrl = await portal.start();

    const landing = await fetch(portalUrl);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('Sign in with Google');

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

    const reloaded = loadConfig(configPath);
    expect(reloaded.spending.limits.find((limit) => limit.interval === 'day' && !limit.scope && !limit.rail)?.amount).toBe(
      5_000_000_000n,
    );
    expect(logger.info).toHaveBeenCalledWith({ configPath }, 'Portal settings persisted');
  });

  it('renders Apple sign-in and handles the form_post callback', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const initialConfig: DaemonFullConfig = {
      ...defaults,
      daemon: {
        ...defaults.daemon,
        dataDir: resolve(dir, 'daemon'),
        pidFile: resolve(dir, 'daemon.pid'),
      },
      auth: {
        mode: 'zklogin',
        google: {
          clientId: 'google-client-id',
        },
        apple: {
          clientId: 'apple-client-id',
        },
        portal: {
          port: 0,
        },
      },
    };
    await writePortalConfigFile(configPath, dir, {
      googleClientId: 'google-client-id',
      appleClientId: 'apple-client-id',
    });
    const config = initialConfig;
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
    const portal = new PortalServer({ config, configPath, authProvider });
    const portalUrl = await portal.start();

    const landing = await fetch(portalUrl);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('Sign in with Google');
    expect(landingHtml).toContain('Sign in with Apple');

    const authRedirect = await fetch(`${portalUrl}/auth/apple`, { redirect: 'manual' });
    expect(authRedirect.status).toBe(302);
    const providerRedirect = authRedirect.headers.get('location');
    expect(providerRedirect).toContain(`${baseUrl}/auth`);

    const providerUrl = new URL(providerRedirect ?? '');
    expect(providerUrl.searchParams.get('redirect_uri')).toBe(`${portalUrl}/auth/apple/callback`);
    expect(providerUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(providerUrl.searchParams.get('response_type')).toBe('code id_token');
    expect(providerUrl.searchParams.get('scope')).toBe('name email');

    const state = providerUrl.searchParams.get('state') ?? '';
    const nonce = providerUrl.searchParams.get('nonce') ?? '';
    const callbackPage = await fetch(`${portalUrl}/auth/apple/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        state,
        id_token: createJwt({
          iss: 'https://appleid.apple.com',
          aud: config.auth.apple?.clientId ?? '',
          sub: 'apple-user',
          nonce,
        }),
        user: JSON.stringify({
          name: { firstName: 'Ada', lastName: 'Lovelace' },
          email: 'ada@example.com',
        }),
      }),
    });
    expect(await callbackPage.text()).toContain('Finish setup');
    expect(authProvider.getSession()?.provider).toBe('apple');
    expect(authProvider.getSession()?.iss).toBe('https://appleid.apple.com');

    await portal.stop();
    await mockOidc.close();
  });

  it('renders the reauth page and auto-closes after re-authentication', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const initialConfig: DaemonFullConfig = {
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
    await writePortalConfigFile(configPath, dir, { googleClientId: 'portal-client-id' });
    const config = initialConfig;
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
    const portal = new PortalServer({ config, configPath, authProvider });
    const portalUrl = await portal.start();

    const reauthPage = await fetch(`${portalUrl}/auth/reauth`);
    expect(await reauthPage.text()).toContain('Your session has expired');

    const authRedirect = await fetch(`${portalUrl}/auth/google?flow=reauth`, { redirect: 'manual' });
    const providerRedirect = authRedirect.headers.get('location');
    const callbackRedirect = await fetch(providerRedirect ?? '', { redirect: 'manual' });
    const callbackUrl = callbackRedirect.headers.get('location');

    const callbackPage = await fetch(callbackUrl ?? '');
    const callbackHtml = await callbackPage.text();
    expect(callbackHtml).toContain('Authentication restored');
    expect(callbackHtml).toContain('window.close()');

    await portal.stop();
    await mockOidc.close();
  });

  it('handles oauth denial and clears the pending PKCE verifier', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const { server: mockOidc, baseUrl } = await startMockOidc();
    const defaults = getDefaultConfig();
    const initialConfig: DaemonFullConfig = {
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
    await writePortalConfigFile(configPath, dir, { googleClientId: 'portal-client-id' });
    const config = initialConfig;
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
    const portal = new PortalServer({ config, configPath, authProvider });
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
