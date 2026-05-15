import { randomBytes, timingSafeEqual } from 'node:crypto';

import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import { computeSharedSecret } from './x25519.js';

export interface EncryptedPayload {
  version: 1;
  senderPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENCRYPTION_CONTEXT = 'agentic-mesh:encrypt:v1';
const NONCE_BYTES = 24;
const PUBLIC_KEY_BYTES = 32;
const TAG_BYTES = 16;

export async function encryptForRecipient(
  plaintext: Uint8Array,
  senderPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<EncryptedPayload> {
  assertByteLength(senderPrivateKey, PUBLIC_KEY_BYTES, 'senderPrivateKey');
  assertByteLength(recipientPublicKey, PUBLIC_KEY_BYTES, 'recipientPublicKey');

  const nonce = randomBytes(NONCE_BYTES);
  const senderPublicKey = x25519.getPublicKey(senderPrivateKey);
  const sharedSecret = computeSharedSecret(senderPrivateKey, recipientPublicKey);
  const encryptionKey = deriveEncryptionKey(sharedSecret, nonce, senderPublicKey, recipientPublicKey);
  const ciphertext = xchacha20poly1305(encryptionKey, nonce).encrypt(plaintext);

  return {
    version: 1,
    senderPublicKey: toHex(senderPublicKey),
    nonce: toHex(nonce),
    ciphertext: toHex(ciphertext),
    tag: toHex(ciphertext.slice(-TAG_BYTES)),
  };
}

export async function decryptFromSender(
  payload: EncryptedPayload,
  recipientPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  assertEncryptedPayload(payload);
  assertByteLength(recipientPrivateKey, PUBLIC_KEY_BYTES, 'recipientPrivateKey');

  const senderPublicKey = fromHexExact(payload.senderPublicKey, PUBLIC_KEY_BYTES, 'senderPublicKey');
  const nonce = fromHexExact(payload.nonce, NONCE_BYTES, 'nonce');
  const ciphertext = fromHexAtLeast(payload.ciphertext, TAG_BYTES, 'ciphertext');
  const tag = fromHexExact(payload.tag, TAG_BYTES, 'tag');

  const actualTag = ciphertext.slice(-TAG_BYTES);
  if (!timingSafeEqual(Buffer.from(actualTag), Buffer.from(tag))) {
    throw new Error('Encrypted payload tag does not match ciphertext.');
  }

  const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey);
  const sharedSecret = computeSharedSecret(recipientPrivateKey, senderPublicKey);
  const encryptionKey = deriveEncryptionKey(sharedSecret, nonce, senderPublicKey, recipientPublicKey);
  return xchacha20poly1305(encryptionKey, nonce).decrypt(ciphertext);
}

export function serializeEncryptedPayload(payload: EncryptedPayload): Uint8Array {
  assertEncryptedPayload(payload);
  return encoder.encode(JSON.stringify(payload));
}

export function parseEncryptedPayload(data: Uint8Array): EncryptedPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(data)) as unknown;
  } catch {
    return null;
  }

  if (!isEncryptedPayload(parsed)) {
    return null;
  }

  return parsed;
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && isExactHexString(candidate.senderPublicKey, PUBLIC_KEY_BYTES)
    && isExactHexString(candidate.nonce, NONCE_BYTES)
    && isHexStringAtLeast(candidate.ciphertext, TAG_BYTES)
    && isExactHexString(candidate.tag, TAG_BYTES);
}

function deriveEncryptionKey(
  sharedSecret: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const info = encoder.encode(`${ENCRYPTION_CONTEXT}:sender:${toHex(senderPublicKey)}:recipient:${toHex(recipientPublicKey)}`);
  return hkdf(sha256, sharedSecret, nonce, info, 32);
}

function assertEncryptedPayload(payload: EncryptedPayload): void {
  if (!isEncryptedPayload(payload)) {
    throw new Error('Invalid encrypted payload.');
  }
}

function assertByteLength(value: Uint8Array, expectedLength: number, field: string): void {
  if (value.length !== expectedLength) {
    throw new Error(`${field} must be ${expectedLength} bytes, received ${value.length}.`);
  }
}

function fromHexExact(value: string, exactBytes: number, field: string): Uint8Array {
  if (!isExactHexString(value, exactBytes)) {
    throw new Error(`${field} must be exactly ${exactBytes} bytes of hex.`);
  }

  return new Uint8Array(Buffer.from(value, 'hex'));
}

function fromHexAtLeast(value: string, minimumBytes: number, field: string): Uint8Array {
  if (!isHexStringAtLeast(value, minimumBytes)) {
    throw new Error(`${field} must be at least ${minimumBytes} bytes of hex.`);
  }

  return new Uint8Array(Buffer.from(value, 'hex'));
}

function isExactHexString(value: unknown, exactBytes: number): value is string {
  return typeof value === 'string' && value.length === exactBytes * 2 && /^[a-f0-9]+$/i.test(value);
}

function isHexStringAtLeast(value: unknown, minimumBytes: number): value is string {
  return typeof value === 'string' && value.length % 2 === 0 && value.length >= minimumBytes * 2 && /^[a-f0-9]+$/i.test(value);
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}
