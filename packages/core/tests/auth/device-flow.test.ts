import { afterEach, describe, expect, it, vi } from 'vitest';

import { pollDeviceFlow, startDeviceFlow } from '../../src/auth/device-flow.js';
import type { OAuthConfig } from '../../src/auth/types.js';

const config: OAuthConfig = {
  provider: 'google',
  clientId: 'test-client',
  redirectUri: 'http://127.0.0.1/callback',
  deviceCodeEndpoint: 'https://oidc.example/device',
  tokenEndpoint: 'https://oidc.example/token',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device flow', () => {
  it('starts the device authorization flow', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://oidc.example/verify',
          device_code: 'device-code',
          interval: 3,
          expires_in: 900,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await startDeviceFlow(config);

    expect(result).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://oidc.example/verify',
      deviceCode: 'device-code',
      pollInterval: 3,
      expiresIn: 900,
    });
  });

  it('surfaces non-JSON errors when starting the device authorization flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>server error</html>', { status: 500 })));

    await expect(startDeviceFlow(config)).rejects.toThrow('OAuth request failed with status 500 (non-JSON response)');
  });

  it('preserves JSON OAuth errors when starting the device authorization flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_client', error_description: 'client rejected' }), { status: 401 }),
      ),
    );

    await expect(startDeviceFlow(config)).rejects.toThrow('client rejected (401)');
  });

  it('returns null while authorization is pending and then returns tokens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: 'jwt-token', refresh_token: 'refresh-token' })),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await pollDeviceFlow('device-code', config)).toBeNull();
    await expect(pollDeviceFlow('device-code', config)).resolves.toEqual({
      jwt: 'jwt-token',
      refreshToken: 'refresh-token',
    });
  });

  it('surfaces non-JSON errors while polling the device flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway error', { status: 502 })));

    await expect(pollDeviceFlow('device-code', config)).rejects.toThrow('OAuth request failed with status 502 (non-JSON response)');
  });

  it('preserves JSON OAuth errors while polling the device flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'access_denied', error_description: 'authorization denied' }), { status: 403 }),
      ),
    );

    await expect(pollDeviceFlow('device-code', config)).rejects.toThrow('authorization denied (403)');
  });
});
