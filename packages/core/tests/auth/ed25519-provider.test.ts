import { describe, expect, it } from 'vitest';

import { Ed25519AuthProvider } from '../../src/auth/ed25519-provider.js';
import { createDID } from '../../src/identity/did.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

describe('Ed25519AuthProvider', () => {
  it('wraps an Ed25519 keypair as an auth provider', async () => {
    const keypair = Ed25519Keypair.generate();
    const provider = new Ed25519AuthProvider(keypair);

    expect(await provider.getAddress()).toBe(keypair.toSuiAddress());
    expect(provider.getDID()).toBe(createDID(keypair.getPublicKey().toRawBytes()));
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getPublicKey()).toEqual(keypair.getPublicKey().toRawBytes());

    const signedTransaction = await provider.signTransaction(new Uint8Array([1, 2, 3]));
    const signedMessage = await provider.signPersonalMessage(new Uint8Array([4, 5, 6]));

    expect(signedTransaction.length).toBeGreaterThan(0);
    expect(signedMessage.signature.length).toBeGreaterThan(0);
    expect(provider.toSuiSigner().toSuiAddress()).toBe(await provider.getAddress());
  });
});
