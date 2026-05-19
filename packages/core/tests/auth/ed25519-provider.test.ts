import { describe, expect, it } from 'vitest';

import { Ed25519AuthProvider } from '../../src/auth/ed25519-provider.js';
import { createDID } from '../../src/identity/did.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

describe('Ed25519AuthProvider', () => {
  it('wraps an Ed25519 keypair as an auth provider', async () => {
    const keypair = Ed25519Keypair.generate();
    const provider = new Ed25519AuthProvider(keypair);
    const transactionBytes = new Uint8Array([1, 2, 3]);
    const messageBytes = new Uint8Array([4, 5, 6]);

    expect(await provider.getAddress()).toBe(keypair.toSuiAddress());
    expect(provider.getDID()).toBe(createDID(keypair.getPublicKey().toRawBytes()));
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getPublicKey()).toEqual(keypair.getPublicKey().toRawBytes());

    const [{ signature: transactionSignature }, { signature: messageSignature }] = await Promise.all([
      keypair.signTransaction(transactionBytes),
      keypair.signPersonalMessage(messageBytes),
    ]);
    const signedTransaction = await provider.signTransaction(transactionBytes);
    const signedMessage = await provider.signPersonalMessage(messageBytes);

    expect(signedTransaction).toEqual(Buffer.from(transactionSignature, 'base64'));
    expect(signedTransaction).not.toEqual(Buffer.from(transactionSignature, 'utf8'));
    expect(Buffer.from(signedTransaction).toString('base64')).toBe(transactionSignature);
    expect(signedMessage.signature).toEqual(Buffer.from(messageSignature, 'base64'));
    expect(signedMessage.signature).not.toEqual(Buffer.from(messageSignature, 'utf8'));
    expect(Buffer.from(signedMessage.signature).toString('base64')).toBe(messageSignature);
    expect(provider.toSuiSigner().toSuiAddress()).toBe(await provider.getAddress());
  });
});
