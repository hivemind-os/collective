import { ed25519, x25519 } from '@noble/curves/ed25519.js';

export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const X25519_KEY_SIZE = 32;

export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return {
    privateKey,
    publicKey: x25519.getPublicKey(privateKey),
  };
}

export function ed25519ToX25519(ed25519PrivateKey: Uint8Array): X25519KeyPair {
  assertKeyLength(ed25519PrivateKey, 'ed25519PrivateKey');

  const privateKey = ed25519.utils.toMontgomerySecret(new Uint8Array(ed25519PrivateKey));
  return {
    privateKey,
    publicKey: x25519.getPublicKey(privateKey),
  };
}

export function computeSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  assertKeyLength(myPrivateKey, 'myPrivateKey');
  assertKeyLength(theirPublicKey, 'theirPublicKey');
  return x25519.getSharedSecret(myPrivateKey, theirPublicKey);
}

function assertKeyLength(key: Uint8Array, field: string): void {
  if (key.length !== X25519_KEY_SIZE) {
    throw new Error(`${field} must be ${X25519_KEY_SIZE} bytes, received ${key.length}.`);
  }
}
