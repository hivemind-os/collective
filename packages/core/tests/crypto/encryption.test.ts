import { describe, expect, it } from 'vitest';

import {
  decryptFromSender,
  encryptForRecipient,
  generateX25519KeyPair,
  parseEncryptedPayload,
  serializeEncryptedPayload,
} from '../../src/index.js';

function createLargePayload(): Uint8Array {
  return Uint8Array.from({ length: 1024 * 1024 }, (_value, index) => index % 251);
}

describe('payload encryption', () => {
  it('encrypts and decrypts payloads', async () => {
    const sender = generateX25519KeyPair();
    const recipient = generateX25519KeyPair();
    const plaintext = new TextEncoder().encode('hello encrypted mesh');

    const payload = await encryptForRecipient(plaintext, sender.privateKey, recipient.publicKey);
    const decrypted = await decryptFromSender(payload, recipient.privateKey);

    expect(Buffer.from(decrypted)).toEqual(Buffer.from(plaintext));
  });

  it('fails to decrypt with the wrong recipient key', async () => {
    const sender = generateX25519KeyPair();
    const recipient = generateX25519KeyPair();
    const outsider = generateX25519KeyPair();
    const payload = await encryptForRecipient(new TextEncoder().encode('secret'), sender.privateKey, recipient.publicKey);

    await expect(decryptFromSender(payload, outsider.privateKey)).rejects.toBeInstanceOf(Error);
  });

  it('uses a fresh nonce for each encryption', async () => {
    const sender = generateX25519KeyPair();
    const recipient = generateX25519KeyPair();
    const plaintext = new TextEncoder().encode('repeatable input');

    const first = await encryptForRecipient(plaintext, sender.privateKey, recipient.publicKey);
    const second = await encryptForRecipient(plaintext, sender.privateKey, recipient.publicKey);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('handles large payloads', async () => {
    const sender = generateX25519KeyPair();
    const recipient = generateX25519KeyPair();
    const plaintext = createLargePayload();

    const payload = await encryptForRecipient(plaintext, sender.privateKey, recipient.publicKey);
    const decrypted = await decryptFromSender(payload, recipient.privateKey);

    expect(Buffer.from(decrypted)).toEqual(Buffer.from(plaintext));
  }, 15_000);

  it('serializes and parses encrypted payloads', async () => {
    const sender = generateX25519KeyPair();
    const recipient = generateX25519KeyPair();
    const payload = await encryptForRecipient(new TextEncoder().encode('serialize me'), sender.privateKey, recipient.publicKey);

    const serialized = serializeEncryptedPayload(payload);
    const parsed = parseEncryptedPayload(serialized);

    expect(parsed).toEqual(payload);
    await expect(decryptFromSender(parsed as NonNullable<typeof parsed>, recipient.privateKey)).resolves.toBeInstanceOf(Uint8Array);
  });
});
