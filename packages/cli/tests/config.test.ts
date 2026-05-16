import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getDefaultIpcPath as getDaemonDefaultIpcPath } from '@hivemind-os/collective-daemon/config';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDefaultConfig, loadMeshConfig } from '../src/commands/config.js';

const createdPaths: string[] = [];
const originalDataDir = process.env.COLLECTIVE_DATA_DIR;

afterEach(async () => {
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

describe('mesh config', () => {
  it('uses the daemon default IPC path', () => {
    const config = buildDefaultConfig(resolve('mesh-config'));

    expect(config.daemon.ipcPath).toBe(getDaemonDefaultIpcPath(config.daemon.dataDir));
  });

  it('preserves an explicit IPC path when COLLECTIVE_DATA_DIR is overridden', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const explicitIpcPath = process.platform === 'win32' ? '\\\\.\\pipe\\hivemind-collective' : resolve(dir, 'custom.sock');
    const overrideDataDir = resolve(dir, 'override-data');

    await writeFile(
      configPath,
      [
        'daemon:',
        `  ipcPath: ${explicitIpcPath}`,
        `  dataDir: ${resolve(dir, 'daemon')}`,
        `  pidFile: ${resolve(dir, 'daemon.pid')}`,
      ].join('\n'),
      'utf8',
    );

    process.env.COLLECTIVE_DATA_DIR = overrideDataDir;

    const config = loadMeshConfig(configPath);

    expect(config.daemon.dataDir).toBe(overrideDataDir);
    expect(config.daemon.ipcPath).toBe(explicitIpcPath);
  });
});
