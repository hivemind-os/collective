import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configIo, getDefaultConfig, getDefaultIpcPath, loadConfig, saveConfig } from '../src/config.js';

const createdPaths: string[] = [];
const envKeys = ['COLLECTIVE_RPC_URL', 'COLLECTIVE_PACKAGE_ID', 'COLLECTIVE_REGISTRY_ID', 'COLLECTIVE_LOG_LEVEL', 'COLLECTIVE_DATA_DIR'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  vi.restoreAllMocks();

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

    expect(config.payment).toMatchObject({
      preferredRail: 'auto',
      evm: { enabled: false, network: 'base' },
    });
    expect(config.encryption).toEqual({ enabled: true, requireEncryption: false });

    if (process.platform === 'win32') {
      expect(config.daemon.ipcPath).toBe(getDefaultIpcPath(config.daemon.dataDir));
      expect(config.daemon.ipcPath.startsWith('\\\\.\\pipe\\hivemind-collective-')).toBe(true);
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
        '      currency: usdc',
        '  perApp:',
        '    claude-desktop:',
        '      limits:',
        '        - amount: "7"',
        '          interval: day',
        'payment:',
        '  preferredRail: x402',
        '  evm:',
        '    enabled: true',
        '    network: base-sepolia',
        '    rpcUrl: https://example.com/base-sepolia',
        'daemon:',
        `  ipcPath: ${resolve(dir, 'daemon.sock')}`,
        `  dataDir: ${resolve(dir, 'daemon')}`,
        `  pidFile: ${resolve(dir, 'daemon.pid')}`,
        '  logLevel: debug',
        'blobstore:',
        '  type: filesystem',
        `  baseDir: ${resolve(dir, 'blobs')}`,
        'encryption:',
        '  enabled: true',
        '  requireEncryption: true',
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
    expect(config.spending.limits[0]?.currency).toBe('USDC');
    expect(config.spending.perApp?.['claude-desktop']?.limits[0]?.amount).toBe(7n);
    expect(config.payment).toMatchObject({
      preferredRail: 'x402',
      evm: {
        enabled: true,
        network: 'base-sepolia',
        rpcUrl: 'https://example.com/base-sepolia',
      },
    });
    expect(config.daemon.logLevel).toBe('debug');
    expect(config.blobstore.mode).toBe('filesystem');
    expect(config.blobstore.filesystem?.dataDir).toBe(resolve(dir, 'blobs'));
    expect(config.encryption).toEqual({ enabled: true, requireEncryption: true });
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

    process.env.COLLECTIVE_RPC_URL = 'http://127.0.0.1:9999';
    process.env.COLLECTIVE_PACKAGE_ID = '0xaaa';
    process.env.COLLECTIVE_REGISTRY_ID = '0xbbb';
    process.env.COLLECTIVE_LOG_LEVEL = 'error';
    process.env.COLLECTIVE_DATA_DIR = dataDir;

    const config = loadConfig(configPath);

    expect(config.network.rpcUrl).toBe('http://127.0.0.1:9999');
    expect(config.network.packageId).toBe('0xaaa');
    expect(config.network.registryId).toBe('0xbbb');
    expect(config.daemon.logLevel).toBe('error');
    expect(config.daemon.dataDir).toBe(dataDir);
    expect(config.identity.dataDir).toBe(resolve(dataDir, 'identity'));
    expect(config.blobstore.filesystem?.dataDir).toBe(resolve(dataDir, 'blobs'));
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

    const config = loadConfig(configPath);

    expect(config.daemon.dataDir).toBe(overrideDataDir);
    expect(config.daemon.ipcPath).toBe(explicitIpcPath);
  });

  it('saves updated portal settings without rewriting unrelated config', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    await writeFile(
      configPath,
      [
        'auth:',
        '  mode: zklogin',
        '  google:',
        '    clientId: original-google-client',
        '  portal:',
        '    port: 0',
        'spending:',
        '  limits:',
        '    - amount: "42"',
        '      interval: day',
        'payment:',
        '  preferredRail: auto',
        'custom:',
        '  keep: true',
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(configPath);
    config.auth.apple = { clientId: 'apple-client' };
    config.auth.portal = { port: 4010 };
    config.payment.preferredRail = 'x402';
    config.spending.limits = [{ amount: 9_000_000_000n, interval: 'day', currency: 'MIST' }];

    await saveConfig(config, configPath);

    const reloaded = loadConfig(configPath);
    const persisted = await readFile(configPath, 'utf8');

    expect(reloaded.auth.google?.clientId).toBe('original-google-client');
    expect(reloaded.auth.apple?.clientId).toBe('apple-client');
    expect(reloaded.auth.portal?.port).toBe(4010);
    expect(reloaded.payment.preferredRail).toBe('x402');
    expect(reloaded.spending.limits[0]?.amount).toBe(9_000_000_000n);
    expect(persisted).toContain('custom:');
    expect(persisted).toContain('keep: true');
    expect(persisted).not.toContain('faucetUrl: http://127.0.0.1:9123');
  });

  it('keeps the last persisted config if an atomic rename fails', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    await writeFile(
      configPath,
      [
        'auth:',
        '  mode: zklogin',
        '  google:',
        '    clientId: test-google-client',
        'spending:',
        '  limits:',
        '    - amount: "42"',
        '      interval: day',
      ].join('\n'),
      'utf8',
    );

    const before = await readFile(configPath, 'utf8');
    const config = loadConfig(configPath);
    config.spending.limits = [{ amount: 99n, interval: 'day', currency: 'MIST' }];

    vi.spyOn(configIo, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(saveConfig(config, configPath)).rejects.toThrow(`Failed to save config to ${configPath}: rename failed`);

    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(loadConfig(configPath).spending.limits[0]?.amount).toBe(42n);
    expect((await readdir(dir)).some((entry) => entry.includes('.tmp'))).toBe(false);
  });

  it('reports clear temp-file write errors when config saves fail', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    await writeFile(
      configPath,
      [
        'auth:',
        '  mode: zklogin',
        '  google:',
        '    clientId: test-google-client',
        'spending:',
        '  limits:',
        '    - amount: "42"',
        '      interval: day',
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(configPath);
    config.spending.limits = [{ amount: 99n, interval: 'day', currency: 'MIST' }];

    vi.spyOn(configIo, 'writeFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await expect(saveConfig(config, configPath)).rejects.toThrow(/Failed to write config temp file .*permission denied/);
    expect((await readdir(dir)).some((entry) => entry.includes('.tmp'))).toBe(false);
  });

  it('creates a default config file when one is missing', async () => {
    const dir = await createTestDir();
    const configPath = resolve(dir, 'config.yaml');

    const config = loadConfig(configPath);

    await access(configPath);
    const persisted = await readFile(configPath, 'utf8');

    expect(config.network.rpcUrl).toBe('https://fullnode.testnet.sui.io:443');
    expect(config.auth.mode).toBe('ed25519');
    expect(config.encryption).toEqual({ enabled: true, requireEncryption: false });
    expect(persisted).toContain('rpcUrl: https://fullnode.testnet.sui.io:443');
    expect(persisted).toContain('mode: ed25519');
    expect(persisted).toContain('requireEncryption: false');
  });
});
