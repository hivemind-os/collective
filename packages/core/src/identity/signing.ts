import { etc, sign as nobleSign, verify as nobleVerify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

const encoder = new TextEncoder();

function configureEd25519(): void {
  if (!etc.sha512Sync) {
    etc.sha512Sync = (...messages) => sha512(etc.concatBytes(...messages));
  }
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  configureEd25519();
  return nobleSign(message, secretKey);
}

export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  configureEd25519();
  return nobleVerify(signature, message, publicKey);
}

export function signString(message: string, secretKey: Uint8Array): string {
  return etc.bytesToHex(sign(encoder.encode(message), secretKey));
}
