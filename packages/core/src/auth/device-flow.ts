import type { DeviceFlowStatus, OAuthConfig } from './types.js';

const DEFAULT_ENDPOINTS = {
  google: {
    deviceCodeEndpoint: 'https://oauth2.googleapis.com/device/code',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  },
  apple: {
    deviceCodeEndpoint: '',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
  },
} as const;

export async function startDeviceFlow(config: OAuthConfig): Promise<DeviceFlowStatus> {
  const endpoint = config.deviceCodeEndpoint ?? DEFAULT_ENDPOINTS[config.provider].deviceCodeEndpoint;
  if (!endpoint) {
    throw new Error(`Device authorization is not configured for provider ${config.provider}.`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      scope: (config.scopes ?? ['openid', 'email']).join(' '),
    }).toString(),
  });

  const payload = await readOAuthPayload(response);
  if (!response.ok) {
    throw new Error(readOAuthError(payload, response.status));
  }

  const userCode = readRequiredString(payload.user_code, 'user_code');
  const verificationUri =
    readOptionalString(payload.verification_uri) ?? readRequiredString(payload.verification_url, 'verification_url');

  return {
    userCode,
    verificationUri,
    deviceCode: readRequiredString(payload.device_code, 'device_code'),
    pollInterval: readOptionalNumber(payload.interval) ?? 5,
    expiresIn: readOptionalNumber(payload.expires_in) ?? 600,
  };
}

export async function pollDeviceFlow(
  deviceCode: string,
  config: OAuthConfig,
): Promise<{
  jwt: string;
  refreshToken?: string;
} | null> {
  const endpoint = config.tokenEndpoint ?? DEFAULT_ENDPOINTS[config.provider].tokenEndpoint;
  if (!endpoint) {
    throw new Error(`Token polling is not configured for provider ${config.provider}.`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString(),
  });

  const payload = await readOAuthPayload(response);
  if (!response.ok) {
    const code = readOptionalString(payload.error);
    if (code === 'authorization_pending' || code === 'slow_down') {
      return null;
    }

    throw new Error(readOAuthError(payload, response.status));
  }

  return {
    jwt: readRequiredString(payload.id_token, 'id_token'),
    refreshToken: readOptionalString(payload.refresh_token),
  };
}

async function readOAuthPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      throw new Error(`OAuth request failed with status ${response.status} (non-JSON response)`);
    }

    throw new Error(`Failed to parse OAuth response as JSON (status ${response.status})`);
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OAuth response is missing ${field}.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOAuthError(payload: Record<string, unknown>, status: number): string {
  const message = readOptionalString(payload.error_description) ?? readOptionalString(payload.error) ?? 'OAuth request failed';
  return `${message} (${status})`;
}
