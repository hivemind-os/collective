import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { etc, getPublicKey, utils } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

function configureEd25519(): void {
  if (!etc.sha512Sync) {
    etc.sha512Sync = (...messages) => sha512(etc.concatBytes(...messages));
  }
}

function enforcePrivateFilePermissions(path: string): void {
  chmodSync(path, 0o600);
}

export interface SimpleKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
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

export function loadOrCreateKeypair(dataDir: string): SimpleKeypair {
  configureEd25519();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const keyPath = join(dataDir, 'identity.key');
  if (existsSync(keyPath)) {
    enforcePrivateFilePermissions(keyPath);
    const secretKey = etc.hexToBytes(readFileSync(keyPath, 'utf8').trim());
    return keypairFromSecretKey(secretKey);
  }

  // v0.1-alpha shortcut: persist the raw secret key in a local file instead of an OS keychain.
  const keypair = generateKeypair();
  writeFileSync(keyPath, etc.bytesToHex(keypair.secretKey), { mode: 0o600 });
  enforcePrivateFilePermissions(keyPath);

  return keypair;
}
