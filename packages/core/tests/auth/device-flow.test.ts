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
});
