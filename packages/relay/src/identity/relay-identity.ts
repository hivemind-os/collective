import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createDID, generateKeypair, keypairFromSecretKey, signString, type SimpleKeypair } from '@agentic-mesh/core';
import type { DID } from '@agentic-mesh/types';

export class RelayIdentity {
  readonly did: DID;

  private constructor(
    readonly keyPath: string,
    readonly keypair: SimpleKeypair,
  ) {
    this.did = createDID(keypair.publicKey);
  }

  static load(keyPath: string): RelayIdentity {
    const resolvedKeyPath = resolve(keyPath);
    mkdirSync(dirname(resolvedKeyPath), { recursive: true, mode: 0o700 });

    if (existsSync(resolvedKeyPath)) {
      chmodSync(resolvedKeyPath, 0o600);
      const secretKey = Uint8Array.from(Buffer.from(readFileSync(resolvedKeyPath, 'utf8').trim(), 'hex'));
      return new RelayIdentity(resolvedKeyPath, keypairFromSecretKey(secretKey));
    }

    const keypair = generateKeypair();
    writeFileSync(resolvedKeyPath, Buffer.from(keypair.secretKey).toString('hex'), { mode: 0o600 });
    chmodSync(resolvedKeyPath, 0o600);
    return new RelayIdentity(resolvedKeyPath, keypair);
  }

  signPayload(payload: string): string {
    return signString(payload, this.keypair.secretKey);
  }
}
