import { describe, expect, it } from 'vitest';

import { deriveEvmKey } from '../../src/auth/evm-key.js';

describe('deriveEvmKey', () => {
  it('derives the same key for the same inputs', () => {
    const first = deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'salt-1', 'user-1');
    const second = deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'salt-1', 'user-1');

    expect(Buffer.from(first).toString('hex')).toBe(Buffer.from(second).toString('hex'));
    expect(first).toHaveLength(32);
  });

  it('changes when any input changes, even for concatenation-collision cases', () => {
    const base = Buffer.from(deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'salt-1', 'user-1')).toString('hex');
    const differentSalt = Buffer.from(deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'salt-2', 'user-1')).toString('hex');
    const differentSub = Buffer.from(deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'salt-1', 'user-2')).toString('hex');
    const collisionA = Buffer.from(deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'ab', 'c')).toString('hex');
    const collisionB = Buffer.from(deriveEvmKey(new Uint8Array([1, 2, 3, 4]), 'a', 'bc')).toString('hex');

    expect(differentSalt).not.toBe(base);
    expect(differentSub).not.toBe(base);
    expect(collisionA).not.toBe(collisionB);
  });

  it('rejects empty inputs', () => {
    expect(() => deriveEvmKey(new Uint8Array(), 'salt-1', 'user-1')).toThrow('identityPrivateKey must not be empty.');
    expect(() => deriveEvmKey(new Uint8Array([1]), '   ', 'user-1')).toThrow('userSalt must not be empty.');
    expect(() => deriveEvmKey(new Uint8Array([1]), 'salt-1', '   ')).toThrow('oauthSub must not be empty.');
  });
});
