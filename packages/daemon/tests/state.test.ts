import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hivemind-os/collective-core', async () => {
  const actual = await vi.importActual<typeof import('@hivemind-os/collective-core')>('@hivemind-os/collective-core');

  class MockMeshSuiClient {
    readonly client = {
      getCurrentEpoch: vi.fn().mockResolvedValue({ epoch: '42' }),
    };

    constructor(_network: unknown) {}
  }

  class MockZkLoginSessionStore {
    constructor(_baseDir: string, _encryptionKey: Uint8Array) {}

    async loadLatestValid(): Promise<null> {
      return null;
    }
  }

  class MockZkLoginProvider {
    readonly mode = 'zklogin' as const;

    constructor(_options: unknown) {}

    async restoreSession(): Promise<boolean> {
      throw new actual.SessionExpiredError('Stored session requires re-authentication.', {
        sessionState: actual.SessionState.NEEDS_REAUTH,
      });
    }

    isAuthenticated(): boolean {
      return false;
    }

    getSessionState() {
      return actual.SessionState.NEEDS_REAUTH;
    }
  }

  return {
    ...actual,
    MeshSuiClient: MockMeshSuiClient,
    ZkLoginProvider: MockZkLoginProvider,
    ZkLoginSessionStore: MockZkLoginSessionStore,
  };
});

import { SessionState } from '@hivemind-os/collective-core';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { buildOAuthConfig, createDaemonIdentityContext } from '../src/state.js';

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

describe('buildOAuthConfig', () => {
  it('prefers the stored Apple provider when configured', () => {
    const defaults = getDefaultConfig();
    const config = {
      ...defaults,
      auth: {
        mode: 'zklogin' as const,
        google: { clientId: 'google-client-id' },
        apple: { clientId: 'apple-client-id' },
        portal: { port: 0 },
      },
    };

    expect(buildOAuthConfig(config, 'http://127.0.0.1/auth/apple/callback', 'apple')).toEqual({
      provider: 'apple',
      clientId: 'apple-client-id',
      redirectUri: 'http://127.0.0.1/auth/apple/callback',
    });
  });

  it('falls back to Google when the preferred provider is unavailable', () => {
    const defaults = getDefaultConfig();
    const config = {
      ...defaults,
      auth: {
        mode: 'zklogin' as const,
        google: { clientId: 'google-client-id' },
        portal: { port: 0 },
      },
    };

    expect(buildOAuthConfig(config, 'http://127.0.0.1/auth/callback', 'apple')).toEqual({
      provider: 'google',
      clientId: 'google-client-id',
      redirectUri: 'http://127.0.0.1/auth/callback',
    });
  });
});

describe('createDaemonIdentityContext', () => {
  it('keeps startup alive when a stored zkLogin session needs re-authentication', async () => {
    const dir = await createTestDir();
    const defaults = getDefaultConfig();
    const config: DaemonFullConfig = {
      ...defaults,
      identity: { dataDir: resolve(dir, 'identity') },
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
        portal: {
          port: 0,
        },
      },
    };

    const context = await createDaemonIdentityContext(config);

    expect(context.authProvider.isAuthenticated()).toBe(false);
    expect(context.authProvider.getSessionState?.()).toBe(SessionState.NEEDS_REAUTH);
  });
});
