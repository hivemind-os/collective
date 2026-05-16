import bs58 from 'bs58';

import type { DID } from '@hivemind-os/collective-types';

const DID_PREFIX = 'did:mesh:';

export function createDID(publicKey: Uint8Array): DID {
  return `${DID_PREFIX}${bs58.encode(publicKey)}` as DID;
}

export function parseDID(did: string): { publicKey: Uint8Array } {
  if (!did.startsWith(DID_PREFIX)) {
    throw new Error(`Invalid DID prefix: ${did}`);
  }

  const encodedKey = did.slice(DID_PREFIX.length);
  if (!encodedKey) {
    throw new Error('DID is missing a public key component.');
  }

  const publicKey = bs58.decode(encodedKey);
  if (publicKey.length !== 32) {
    throw new Error('DID public key must decode to 32 bytes.');
  }

  return { publicKey };
}

export function isValidDID(did: string): boolean {
  try {
    parseDID(did);
    return true;
  } catch {
    return false;
  }
}
