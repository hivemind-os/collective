import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultConfig, loadConfig } from '../src/config.js';

const createdPaths: string[] = [];
const envKeys = ['MESH_RPC_URL', 'MESH_PACKAGE_ID', 'MESH_REGISTRY_ID', 'MESH_LOG_LEVEL', 'MESH_DATA_DIR'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('config', () => {
  it('returns the correct platform default ipc path', () => {
    const config = getDefaultConfig();

    if (process.platform === 'win32') {
      expect(config.daemon.ipcPath).toBe('\\\\.\\pipe\\agentic-mesh');
    } else {
      expect(config.daemon.ipcPath.endsWith('mesh.sock')).toBe(true);
    }
  });

  it('loads config values from YAML', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    await writeFile(
      configPath,
      [
        'network:',
        '  rpcUrl: http://127.0.0.1:1234',
        '  faucetUrl: http://127.0.0.1:4321',
        '  packageId: 0xabc',
        '  registryId: 0xdef',
        'identity:',
        `  dataDir: ${resolve(dir, 'identity')}`,
        'auth:',
        '  mode: zklogin',
        '  google:',
        '    clientId: test-google-client',
        '  portal:',
        '    port: 0',
        'spending:',
        '  limits:',
        '    - amount: "42"',
        '      interval: transaction',
        '  perApp:',
        '    claude-desktop:',
        '      limits:',
        '        - amount: "7"',
        '          interval: day',
        'daemon:',
        `  ipcPath: ${resolve(dir, 'daemon.sock')}`,
        `  dataDir: ${resolve(dir, 'daemon')}`,
        `  pidFile: ${resolve(dir, 'daemon.pid')}`,
        '  logLevel: debug',
        'blobstore:',
        '  type: filesystem',
        `  baseDir: ${resolve(dir, 'blobs')}`,
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(configPath);

    expect(config.network.rpcUrl).toBe('http://127.0.0.1:1234');
    expect(config.network.faucetUrl).toBe('http://127.0.0.1:4321');
    expect(config.network.packageId).toBe('0xabc');
    expect(config.network.registryId).toBe('0xdef');
    expect(config.auth.mode).toBe('zklogin');
    expect(config.auth.google?.clientId).toBe('test-google-client');
    expect(config.auth.portal?.port).toBe(0);
    expect(config.spending.limits[0]?.amount).toBe(42n);
    expect(config.spending.perApp?.['claude-desktop']?.limits[0]?.amount).toBe(7n);
    expect(config.daemon.logLevel).toBe('debug');
    expect(config.blobstore.mode).toBe('filesystem');
    expect(config.blobstore.filesystem?.dataDir).toBe(resolve(dir, 'blobs'));
  });

  it('loads walrus blobstore settings from YAML', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    await writeFile(
      configPath,
      [
        'auth:',
        '  mode: ed25519',
        'blobstore:',
        '  mode: hybrid',
        '  filesystem:',
        `    dataDir: ${resolve(dir, 'blob-cache')}`,
        '  walrus:',
        '    publisherUrl: https://publisher.example.com',
        '    aggregatorUrl: https://aggregator.example.com',
        '    epochs: 7',
        '    maxBlobSize: 2048',
        '  hybrid:',
        '    cacheLocally: true',
        '    preferWalrus: false',
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(configPath);

    expect(config.blobstore).toMatchObject({
      mode: 'hybrid',
      filesystem: { dataDir: resolve(dir, 'blob-cache') },
      walrus: {
        publisherUrl: 'https://publisher.example.com',
        aggregatorUrl: 'https://aggregator.example.com',
        epochs: 7,
        maxBlobSize: 2048,
      },
      hybrid: {
        cacheLocally: true,
        preferWalrus: false,
      },
    });
  });

  it('applies environment variable overrides', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');
    const dataDir = resolve(dir, 'override-data');

    await writeFile(
      configPath,
      [
        'network:',
        '  rpcUrl: http://127.0.0.1:1111',
        '  packageId: 0x1',
        '  registryId: 0x2',
        'daemon:',
        '  logLevel: info',
      ].join('\n'),
      'utf8',
    );

    process.env.MESH_RPC_URL = 'http://127.0.0.1:9999';
    process.env.MESH_PACKAGE_ID = '0xaaa';
    process.env.MESH_REGISTRY_ID = '0xbbb';
    process.env.MESH_LOG_LEVEL = 'error';
    process.env.MESH_DATA_DIR = dataDir;

    const config = loadConfig(configPath);

    expect(config.network.rpcUrl).toBe('http://127.0.0.1:9999');
    expect(config.network.packageId).toBe('0xaaa');
    expect(config.network.registryId).toBe('0xbbb');
    expect(config.daemon.logLevel).toBe('error');
    expect(config.daemon.dataDir).toBe(dataDir);
    expect(config.identity.dataDir).toBe(resolve(dataDir, 'identity'));
    expect(config.blobstore.filesystem?.dataDir).toBe(resolve(dataDir, 'blobs'));
  });

  it('creates a default config file when one is missing', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    const config = loadConfig(configPath);

    await access(configPath);
    const persisted = await readFile(configPath, 'utf8');

    expect(config.network.rpcUrl).toBe('http://127.0.0.1:9000');
    expect(config.auth.mode).toBe('ed25519');
    expect(persisted).toContain('rpcUrl: http://127.0.0.1:9000');
    expect(persisted).toContain('mode: ed25519');
  });
});
