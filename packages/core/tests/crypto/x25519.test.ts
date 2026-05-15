import { describe, expect, it } from 'vitest';

import { computeSharedSecret, ed25519ToX25519, generateX25519KeyPair } from '../../src/index.js';

function fixedSecret(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (start + index) % 256);
}

describe('x25519', () => {
  it('generates 32-byte keypairs', () => {
    const keyPair = generateX25519KeyPair();

    expect(keyPair.privateKey).toHaveLength(32);
    expect(keyPair.publicKey).toHaveLength(32);
  });

  it('converts Ed25519 keys deterministically', () => {
    const secretKey = fixedSecret(1);

    const first = ed25519ToX25519(secretKey);
    const second = ed25519ToX25519(secretKey);

    expect(Buffer.from(first.privateKey)).toEqual(Buffer.from(second.privateKey));
    expect(Buffer.from(first.publicKey)).toEqual(Buffer.from(second.publicKey));
  });

  it('derives the same shared secret for both peers', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();

    const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(Buffer.from(aliceShared)).toEqual(Buffer.from(bobShared));
  });

  it('produces different shared secrets for different peers', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();
    const carol = generateX25519KeyPair();

    const sharedWithBob = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedWithCarol = computeSharedSecret(alice.privateKey, carol.publicKey);

    expect(Buffer.from(sharedWithBob)).not.toEqual(Buffer.from(sharedWithCarol));
  });
});
