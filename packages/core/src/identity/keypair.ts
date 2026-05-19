import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { etc, getPublicKey, utils } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import pino from 'pino';

const logger = pino({ name: '@hivemind-os/collective-core:identity' });
const IDENTITY_KEY_FILENAME = 'identity.key';
const KEYCHAIN_SERVICE = 'hivemind-collective';
const KEYCHAIN_ACCOUNT = 'identity-key';

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let keytarModulePromise: Promise<KeytarModule | null> | undefined;
let hasLoggedKeychainFallback = false;

function configureEd25519(): void {
  if (!etc.sha512Sync) {
    etc.sha512Sync = (...messages) => sha512(etc.concatBytes(...messages));
  }
}

function enforcePrivateFilePermissions(path: string): void {
  chmodSync(path, 0o600);
}

function getIdentityKeyPath(dataDir: string): string {
  return join(dataDir, IDENTITY_KEY_FILENAME);
}

function logKeychainFallback(error: unknown): void {
  if (!hasLoggedKeychainFallback) {
    logger.warn({ err: error }, 'OS keychain unavailable; insecure file-based identity storage requires explicit opt-in.');
    hasLoggedKeychainFallback = true;
  }
}

async function importKeytar(): Promise<KeytarModule | null> {
  try {
    const imported = await import('keytar');
    const keytar = ('default' in imported && imported.default ? imported.default : imported) as Partial<KeytarModule>;
    if (typeof keytar.getPassword !== 'function' || typeof keytar.setPassword !== 'function') {
      throw new Error('keytar module is missing required methods.');
    }

    return {
      getPassword: keytar.getPassword.bind(keytar),
      setPassword: keytar.setPassword.bind(keytar),
    };
  } catch (error) {
    logKeychainFallback(error);
    return null;
  }
}

async function getKeytarModule(): Promise<KeytarModule | null> {
  keytarModulePromise ??= importKeytar();
  return await keytarModulePromise;
}

async function loadOrCreateStoredKeypair(store: KeyStore): Promise<SimpleKeypair> {
  if (await store.exists()) {
    return keypairFromSecretKey(await store.load());
  }

  const keypair = generateKeypair();
  await store.save(keypair.secretKey);
  return keypair;
}

export interface SimpleKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface KeyStore {
  load(): Promise<Uint8Array>;
  save(secretKey: Uint8Array): Promise<void>;
  exists(): Promise<boolean>;
}

export interface KeyStoreOptions {
  allowInsecureFileStorage?: boolean;
}

export class FileKeyStore implements KeyStore {
  constructor(private readonly keyPath: string) {}

  async load(): Promise<Uint8Array> {
    enforcePrivateFilePermissions(this.keyPath);
    return etc.hexToBytes(readFileSync(this.keyPath, 'utf8').trim());
  }

  async save(secretKey: Uint8Array): Promise<void> {
    writeFileSync(this.keyPath, etc.bytesToHex(secretKey), { mode: 0o600 });
    enforcePrivateFilePermissions(this.keyPath);
  }

  async exists(): Promise<boolean> {
    return existsSync(this.keyPath);
  }

  delete(): void {
    unlinkSync(this.keyPath);
  }
}

export class KeychainStore implements KeyStore {
  constructor(
    private readonly keytar: KeytarModule,
    private readonly service = KEYCHAIN_SERVICE,
    private readonly account = KEYCHAIN_ACCOUNT,
  ) {}

  async load(): Promise<Uint8Array> {
    const secretKey = await this.keytar.getPassword(this.service, this.account);
    if (!secretKey) {
      throw new Error('Identity key not found in OS keychain.');
    }

    return etc.hexToBytes(secretKey);
  }

  async save(secretKey: Uint8Array): Promise<void> {
    await this.keytar.setPassword(this.service, this.account, etc.bytesToHex(secretKey));
  }

  async exists(): Promise<boolean> {
    return (await this.keytar.getPassword(this.service, this.account)) !== null;
  }
}

export function generateKeypair(): SimpleKeypair {
  configureEd25519();
  const secretKey = utils.randomPrivateKey();
  const publicKey = getPublicKey(secretKey);

  return { publicKey, secretKey };
}

export function keypairFromSecretKey(secretKey: Uint8Array): SimpleKeypair {
  configureEd25519();
  const normalizedSecretKey = new Uint8Array(secretKey);
  const publicKey = getPublicKey(normalizedSecretKey);

  return {
    publicKey,
    secretKey: normalizedSecretKey,
  };
}

export async function createKeyStore(dataDir: string, options: KeyStoreOptions = {}): Promise<KeyStore> {
  const keytar = await getKeytarModule();
  if (keytar) {
    return new KeychainStore(keytar);
  }
  if (!options.allowInsecureFileStorage) {
    throw new Error(
      'OS keychain is unavailable and insecure file-based key storage is not permitted. ' +
      'Set allowInsecureFileStorage: true to explicitly opt in to plaintext file storage.',
    );
  }

  logger.warn('Using insecure file-based key storage. Keys are stored as plaintext on disk.');
  return new FileKeyStore(getIdentityKeyPath(dataDir));
}

export async function identityKeyExists(dataDir: string): Promise<boolean> {
  const fileStore = new FileKeyStore(getIdentityKeyPath(dataDir));
  if (await fileStore.exists()) {
    return true;
  }

  const keyStore = await createKeyStore(dataDir, { allowInsecureFileStorage: true });
  if (keyStore instanceof KeychainStore) {
    try {
      return await keyStore.exists();
    } catch (error) {
      logKeychainFallback(error);
      return await fileStore.exists();
    }
  }

  return await keyStore.exists();
}

export async function loadOrCreateKeypair(dataDir: string, options: KeyStoreOptions = {}): Promise<SimpleKeypair> {
  configureEd25519();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const fileStore = new FileKeyStore(getIdentityKeyPath(dataDir));
  const keyStore = await createKeyStore(dataDir, options);

  if (keyStore instanceof KeychainStore) {
    try {
      if (await fileStore.exists()) {
        const secretKey = await fileStore.load();
        await keyStore.save(secretKey);
        fileStore.delete();
        return keypairFromSecretKey(secretKey);
      }

      return await loadOrCreateStoredKeypair(keyStore);
    } catch (error) {
      if (!options.allowInsecureFileStorage) {
        throw new Error(
          `OS keychain operation failed and insecure file storage is not permitted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      logKeychainFallback(error);
    }
  }

  return await loadOrCreateStoredKeypair(fileStore);
}
