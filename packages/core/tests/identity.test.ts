import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const createdPaths: string[] = [];
const encoder = new TextEncoder();

interface KeytarMock {
  getPassword: ReturnType<typeof vi.fn>;
  setPassword: ReturnType<typeof vi.fn>;
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('keytar');
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDataDir(): Promise<string> {
  const dataDir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dataDir);
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createKeytarMock(): { keytar: KeytarMock; secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  const keytar = {
    getPassword: vi.fn(async (service: string, account: string) => secrets.get(`${service}:${account}`) ?? null),
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      secrets.set(`${service}:${account}`, password);
    }),
  };

  return { keytar, secrets };
}

function createUnavailableKeytarMock(): KeytarMock {
  return {
    getPassword: vi.fn(async () => {
      throw new Error('keytar unavailable');
    }),
    setPassword: vi.fn(async () => {
      throw new Error('keytar unavailable');
    }),
  };
}

async function loadKeypairModule(options?: { keytar?: KeytarMock; keytarImportError?: Error }) {
  vi.resetModules();
  vi.doUnmock('keytar');

  if (options?.keytarImportError) {
    vi.doMock('keytar', () => {
      throw options.keytarImportError;
    });
  } else if (options?.keytar) {
    vi.doMock('keytar', () => ({
      default: options.keytar,
      ...options.keytar,
    }));
  }

  return await import('../src/identity/keypair.js');
}

describe('identity', () => {
  it('generates a keypair with a 32-byte public key', async () => {
    const { generateKeypair } = await loadKeypairModule();
    const keypair = generateKeypair();

    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  it('uses the OS keychain when available regardless of file storage options', async () => {
    const dataDir = await createDataDir();
    const keyPath = join(dataDir, 'identity.key');
    const { keytar, secrets } = createKeytarMock();
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytar });

    const first = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: false });
    const second = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: true });

    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(Buffer.from(second.publicKey)).toEqual(Buffer.from(first.publicKey));
    expect(await fileExists(keyPath)).toBe(false);
    expect(secrets.get('hivemind-collective:identity-key')).toBe(Buffer.from(first.secretKey).toString('hex'));
  });

  it('migrates legacy file-based keys into the OS keychain', async () => {
    const dataDir = await createDataDir();
    const keyPath = join(dataDir, 'identity.key');
    const { generateKeypair } = await loadKeypairModule();
    const legacyKeypair = generateKeypair();
    await writeFile(keyPath, Buffer.from(legacyKeypair.secretKey).toString('hex'));

    const { keytar, secrets } = createKeytarMock();
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytar });
    const loaded = await loadOrCreateKeypair(dataDir);

    expect(Buffer.from(loaded.secretKey)).toEqual(Buffer.from(legacyKeypair.secretKey));
    expect(await fileExists(keyPath)).toBe(false);
    expect(secrets.get('hivemind-collective:identity-key')).toBe(Buffer.from(legacyKeypair.secretKey).toString('hex'));
  });

  it('throws when keytar cannot be imported and insecure file storage is not enabled', async () => {
    const dataDir = await createDataDir();
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytarImportError: new Error('keytar unavailable') });

    await expect(loadOrCreateKeypair(dataDir)).rejects.toThrow(
      'OS keychain is unavailable and insecure file-based key storage is not permitted.',
    );
  });

  it('uses file storage only when explicitly allowed after keytar import failure', async () => {
    const dataDir = await createDataDir();
    const keyPath = join(dataDir, 'identity.key');
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytarImportError: new Error('keytar unavailable') });

    const first = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: true });
    const second = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: true });

    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(await fileExists(keyPath)).toBe(true);
    expect((await readFile(keyPath, 'utf8')).trim()).toBe(Buffer.from(first.secretKey).toString('hex'));
  });

  it('throws when keychain operations fail and insecure file storage is not enabled', async () => {
    const dataDir = await createDataDir();
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytar: createUnavailableKeytarMock() });

    await expect(loadOrCreateKeypair(dataDir)).rejects.toThrow(
      'OS keychain operation failed and insecure file storage is not permitted: keytar unavailable',
    );
  });

  it('falls back to file storage when explicitly allowed after keychain operation failures', async () => {
    const dataDir = await createDataDir();
    const keyPath = join(dataDir, 'identity.key');
    const { loadOrCreateKeypair } = await loadKeypairModule({ keytar: createUnavailableKeytarMock() });

    const first = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: true });
    const second = await loadOrCreateKeypair(dataDir, { allowInsecureFileStorage: true });

    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(await fileExists(keyPath)).toBe(true);
    expect((await readFile(keyPath, 'utf8')).trim()).toBe(Buffer.from(first.secretKey).toString('hex'));
  });

  it('creates and parses DIDs', async () => {
    const [{ createDID, parseDID }, { generateKeypair }] = await Promise.all([
      import('../src/identity/did.js'),
      loadKeypairModule(),
    ]);
    const keypair = generateKeypair();
    const did = createDID(keypair.publicKey);
    const parsed = parseDID(did);

    expect(did).toMatch(/^did:mesh:/);
    expect(Buffer.from(parsed.publicKey)).toEqual(Buffer.from(keypair.publicKey));
  });

  it('signs and verifies messages', async () => {
    const [{ sign, verify }, { generateKeypair }] = await Promise.all([
      import('../src/identity/signing.js'),
      loadKeypairModule(),
    ]);
    const keypair = generateKeypair();
    const message = encoder.encode('agentic mesh');
    const signature = sign(message, keypair.secretKey);

    expect(verify(message, signature, keypair.publicKey)).toBe(true);
    expect(verify(encoder.encode('tampered'), signature, keypair.publicKey)).toBe(false);
  });

  it('rejects invalid DID formats', async () => {
    const { isValidDID, parseDID } = await import('../src/identity/did.js');

    expect(isValidDID('did:other:abc')).toBe(false);
    expect(() => parseDID('did:mesh:')).toThrow();
  });
});
