import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const DERIVED_KEY_LENGTH = 32;
const encoder = new TextEncoder();

export function deriveEvmKey(identityPrivateKey: Uint8Array, userSalt: string, oauthSub: string): Uint8Array {
  if (identityPrivateKey.byteLength === 0) {
    throw new Error('identityPrivateKey must not be empty.');
  }

  const normalizedUserSalt = normalizeRequiredString(userSalt, 'userSalt');
  const normalizedOauthSub = normalizeRequiredString(oauthSub, 'oauthSub');

  return hkdf(
    sha256,
    identityPrivateKey,
    buildDerivationSalt(normalizedUserSalt, normalizedOauthSub),
    encoder.encode('agentic-mesh:evm:v1'),
    DERIVED_KEY_LENGTH,
  );
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty.`);
  }

  return normalized;
}

function buildDerivationSalt(userSalt: string, oauthSub: string): Uint8Array {
  return sha256(concatBytes(encodeLengthPrefixed(userSalt), encodeLengthPrefixed(oauthSub)));
}

function encodeLengthPrefixed(value: string): Uint8Array {
  const encodedValue = encoder.encode(value);
  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(0, encodedValue.length, false);
  return concatBytes(lengthPrefix, encodedValue);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}
