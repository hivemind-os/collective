import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { OAuthConfig } from '@agentic-mesh/core';

interface PendingCode {
  nonce: string;
  clientId: string;
}

interface DeviceGrant {
  clientId: string;
  approved: boolean;
  nonce?: string;
}

export class MockOidcProvider {
  private readonly server: FastifyInstance;
  private readonly codes = new Map<string, PendingCode>();
  private readonly deviceGrants = new Map<string, DeviceGrant>();
  private baseUrl = '';

  constructor(
    private readonly claims: {
      iss?: string;
      sub?: string;
      aud?: string;
    } = {},
  ) {
    this.server = Fastify({ logger: false });
    this.server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const text = typeof body === 'string' ? body : body.toString();
      done(null, Object.fromEntries(new URLSearchParams(text)));
    });
    this.registerRoutes();
  }

  async start(port?: number): Promise<string> {
    const address = await this.server.listen({ host: '127.0.0.1', port: port ?? 0 });
    this.baseUrl = address;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await this.server.close().catch(() => undefined);
  }

  get oauthConfig(): OAuthConfig {
    if (!this.baseUrl) {
      throw new Error('MockOidcProvider must be started before oauthConfig is used.');
    }

    return {
      provider: 'google',
      clientId: this.claims.aud ?? 'mock-client-id',
      redirectUri: '',
      authorizationEndpoint: `${this.baseUrl}/auth`,
      tokenEndpoint: `${this.baseUrl}/token`,
      deviceCodeEndpoint: `${this.baseUrl}/device/code`,
      saltEndpoint: `${this.baseUrl}/get_salt`,
      proverEndpoint: `${this.baseUrl}/v1`,
    };
  }

  approveDeviceCode(deviceCode: string): void {
    const current = this.deviceGrants.get(deviceCode);
    if (current) {
      this.deviceGrants.set(deviceCode, { ...current, approved: true });
    }
  }

  private registerRoutes(): void {
    this.server.get('/auth', async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const code = `code-${randomUUID()}`;
      this.codes.set(code, {
        nonce: query.nonce ?? '',
        clientId: query.client_id ?? this.claims.aud ?? 'mock-client-id',
      });
      reply.redirect(`${query.redirect_uri}?code=${code}&state=${query.state}`);
    });

    this.server.post('/token', async (request, reply) => {
      const body = request.body as Record<string, string>;
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const grant = this.deviceGrants.get(body.device_code ?? '');
        if (!grant || !grant.approved) {
          reply.code(400);
          return { error: 'authorization_pending' };
        }

        return this.buildTokenResponse({ clientId: grant.clientId, nonce: grant.nonce });
      }

      if (body.grant_type === 'refresh_token') {
        return this.buildTokenResponse({ clientId: this.claims.aud ?? 'mock-client-id', nonce: body.nonce });
      }

      const code = this.codes.get(body.code ?? '');
      if (!code) {
        reply.code(400);
        return { error: 'invalid_grant' };
      }

      return this.buildTokenResponse({ clientId: code.clientId, nonce: code.nonce });
    });

    this.server.post('/device/code', async (request) => {
      const body = request.body as Record<string, string>;
      const deviceCode = `device-${randomUUID()}`;
      this.deviceGrants.set(deviceCode, {
        clientId: body.client_id ?? this.claims.aud ?? 'mock-client-id',
        approved: false,
      });

      return {
        device_code: deviceCode,
        user_code: 'MOCK-CODE',
        verification_uri: `${this.baseUrl}/verify`,
        expires_in: 600,
        interval: 2,
      };
    });

    this.server.get('/verify', async () => ({ ok: true }));
    this.server.post('/get_salt', async () => ({ salt: '123456' }));
    this.server.post('/v1', async () => ({
      proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
      issBase64Details: { value: 'issuer', indexMod4: 1 },
      headerBase64: 'header',
    }));
  }

  private buildTokenResponse(params: { clientId: string; nonce?: string }) {
    return {
      access_token: 'mock-access-token',
      id_token: createJwt({
        iss: this.claims.iss ?? 'https://accounts.google.com',
        aud: params.clientId,
        sub: this.claims.sub ?? 'mock-subject',
        nonce: params.nonce,
      }),
      refresh_token: 'mock-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };
  }
}

function createJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}
