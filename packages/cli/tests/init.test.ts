import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleInit } from '../src/commands/init.js';

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
  await access(resolve(process.cwd()), 0);
  return dir;
}

describe('mesh init', () => {
  it('creates directory structure', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;

    await expect(handleInit([])).resolves.toBe(0);
    await expect(access(dataDir)).resolves.toBeUndefined();
    await expect(access(resolve(dataDir, 'identity'))).resolves.toBeUndefined();
  });

  it('generates identity key', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;

    await handleInit([]);

    const keyPath = join(dataDir, 'identity', 'identity.key');
    await expect(access(keyPath)).resolves.toBeUndefined();
    const keyContents = await readFile(keyPath, 'utf8');
    expect(keyContents.trim()).toMatch(/^[0-9a-f]+$/i);
  });

  it('creates config.yaml with defaults', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;

    await handleInit([]);

    const configPath = resolve(dataDir, 'config.yaml');
    const configContents = await readFile(configPath, 'utf8');
    expect(configContents).toContain('rpcUrl: http://127.0.0.1:9000');
    expect(configContents).toContain('daemon:');
    expect(configContents).toContain('logFile:');
  });

  it('is idempotent and does not overwrite the key', async () => {
    const dataDir = await createTestDir();
    process.env.MESH_DATA_DIR = dataDir;

    await handleInit([]);
    const keyPath = join(dataDir, 'identity', 'identity.key');
    const first = await readFile(keyPath, 'utf8');

    await handleInit([]);
    const second = await readFile(keyPath, 'utf8');

    expect(second).toBe(first);
  });
});
