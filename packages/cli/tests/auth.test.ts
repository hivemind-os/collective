import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDefaultConfig, saveMeshConfig } from '../src/commands/config.js';
import { handleAuth, type AuthCommandDeps } from '../src/commands/auth.js';

const createdPaths: string[] = [];
const originalDataDir = process.env.MESH_DATA_DIR;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) {
    delete process.env.MESH_DATA_DIR;
  } else {
    process.env.MESH_DATA_DIR = originalDataDir;
  }
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createDeps(overrides: Partial<AuthCommandDeps> = {}): AuthCommandDeps {
  return {
    getAuthStatus: vi.fn().mockResolvedValue({
      authMode: 'zklogin',
      authenticated: false,
      state: 'reauth_required',
      address: '0x123',
      expiresAt: 1_700_000_000_000,
      expiresInMs: -1,
      refreshAvailable: true,
      lastError: 'Authentication expired. Please re-authenticate via the daemon portal.',
      updatedAt: 1_700_000_000_000,
    }),
    triggerReauth: vi.fn().mockResolvedValue({
      portalUrl: 'http://127.0.0.1:19876/auth/reauth',
      browserOpened: false,
      status: {
        authMode: 'zklogin',
        authenticated: false,
        state: 'reauth_required',
        address: '0x123',
        expiresAt: 1_700_000_000_000,
        expiresInMs: -1,
        refreshAvailable: true,
        lastError: 'Authentication expired. Please re-authenticate via the daemon portal.',
        updatedAt: 1_700_000_000_000,
      },
    }),
    ...overrides,
  };
}

describe('mesh auth', () => {
  it('prints daemon auth status', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;
    saveMeshConfig(buildDefaultConfig(dataDir));

    const deps = createDeps();

    await expect(handleAuth('status', [], deps)).resolves.toBe(1);
    expect(deps.getAuthStatus).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith('State: reauth_required (action required)');
  });

  it('triggers daemon reauth and prints the portal url', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;
    saveMeshConfig(buildDefaultConfig(dataDir));

    const deps = createDeps();

    await expect(handleAuth('reauth', [], deps)).resolves.toBe(1);
    expect(deps.triggerReauth).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith('Auth Mode: zklogin');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Open the re-auth portal manually'));
  });
});
