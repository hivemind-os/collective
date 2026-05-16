import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDefaultConfig, saveMeshConfig } from '../src/commands/config.js';
import { handleDaemon, type DaemonCommandDeps } from '../src/commands/daemon.js';

const createdPaths: string[] = [];
const originalDataDir = process.env.COLLECTIVE_DATA_DIR;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
  await mkdir(dir, { recursive: true });
  return dir;
}

function createDeps(overrides: Partial<DaemonCommandDeps> = {}): DaemonCommandDeps {
  return {
    spawnProcess: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
    resolveDaemonCommand: vi.fn().mockResolvedValue({ command: process.execPath, args: ['daemon-entry.js'] }),
    getStatus: vi.fn().mockResolvedValue({
      did: 'did:mesh:test',
      address: '0x123',
      uptimeMs: 1_000,
      connectedApps: [],
    }),
    killProcess: vi.fn(),
    isProcessRunning: vi.fn().mockReturnValue(false),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('mesh daemon', () => {
  it('status returns not-running when no PID file exists', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;
    saveMeshConfig(buildDefaultConfig(dataDir));

    await expect(handleDaemon('status')).resolves.toBe(1);
  });

  it('start spawns the daemon process', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;
    saveMeshConfig(buildDefaultConfig(dataDir));

    const deps = createDeps();
    await expect(handleDaemon('start', [], deps)).resolves.toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['daemon-entry.js'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('stop kills the daemon process', async () => {
    const dataDir = await createTestDir();
    process.env.COLLECTIVE_DATA_DIR = dataDir;
    const config = buildDefaultConfig(dataDir);
    saveMeshConfig(config);
    await writeFile(config.daemon.pidFile, '4242\n', 'utf8');

    const isProcessRunning = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const deps = createDeps({
      isProcessRunning,
    });

    await expect(handleDaemon('stop', [], deps)).resolves.toBe(0);
    expect(deps.killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
  });
});
