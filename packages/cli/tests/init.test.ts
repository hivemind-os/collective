import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateDID, mockIdentityKeyExists, mockLoadOrCreateKeypair } = vi.hoisted(() => ({
  mockCreateDID: vi.fn(() => 'did:mesh:test'),
  mockIdentityKeyExists: vi.fn<() => Promise<boolean>>(),
  mockLoadOrCreateKeypair: vi.fn<() => Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }>>(),
}));

vi.mock('@hivemind-os/collective-core', () => ({
  createDID: mockCreateDID,
  identityKeyExists: mockIdentityKeyExists,
  loadOrCreateKeypair: mockLoadOrCreateKeypair,
}));

import { handleInit } from '../src/commands/init.js';

const createdPaths: string[] = [];
const originalDataDir = process.env.COLLECTIVE_DATA_DIR;
const mockIdentity = {
  publicKey: new Uint8Array(32).fill(1),
  secretKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockCreateDID.mockReturnValue('did:mesh:test');
  mockIdentityKeyExists.mockReset().mockResolvedValue(false);
  mockLoadOrCreateKeypair.mockReset().mockResolvedValue(mockIdentity);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) {
    delete process.env.COLLECTIVE_DATA_DIR;
  } else {
    process.env.COLLECTIVE_DATA_DIR = originalDataDir;
  }
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await access(resolve(process.cwd()), 0);
  return dir;
}

describe('mesh init', () => {
  it('creates directory structure', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;

    await expect(handleInit([])).resolves.toBe(0);
    await expect(access(dataDir)).resolves.toBeUndefined();
    await expect(access(resolve(dataDir, 'identity'))).resolves.toBeUndefined();
  });

  it('reports when a new identity key is generated', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;

    await handleInit([]);

    expect(mockIdentityKeyExists).toHaveBeenCalledWith(resolve(dataDir, 'identity'));
    expect(mockLoadOrCreateKeypair).toHaveBeenCalledWith(resolve(dataDir, 'identity'));
    expect(vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes('Generated identity key'))).toBe(true);
  });

  it('creates config.yaml with defaults', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;

    await handleInit([]);

    const configPath = resolve(dataDir, 'config.yaml');
    const configContents = await readFile(configPath, 'utf8');
    expect(configContents).toContain('rpcUrl: https://fullnode.testnet.sui.io:443');
    expect(configContents).toContain('daemon:');
    expect(configContents).toContain('logFile:');
  });

  it('reports when an existing identity key is loaded', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;
    mockIdentityKeyExists.mockResolvedValue(true);

    await handleInit([]);

    expect(vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes('Loaded identity key'))).toBe(true);
  });
});
