import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { createDID } from '../identity/did.js';

import type { AuthProvider } from './types.js';

export class Ed25519AuthProvider implements AuthProvider {
  readonly mode = 'ed25519' as const;

  constructor(private readonly keypair: Ed25519Keypair) {}

  async getAddress(): Promise<string> {
    return this.keypair.toSuiAddress();
  }

  getDID(): string {
    return createDID(this.keypair.getPublicKey().toRawBytes());
  }

  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.keypair.signTransaction(tx);
    return Buffer.from(signature, 'base64');
  }

  async signPersonalMessage(message: Uint8Array): Promise<{ signature: Uint8Array }> {
    const { signature } = await this.keypair.signPersonalMessage(message);
    return { signature: Buffer.from(signature, 'base64') };
  }

  isAuthenticated(): boolean {
    return true;
  }

  getPublicKey(): Uint8Array {
    return this.keypair.getPublicKey().toRawBytes();
  }

  toSuiSigner(): Ed25519Keypair {
    return this.keypair;
  }
}
