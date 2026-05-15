import { describe, expect, it } from 'vitest';

import { HashChain } from '../../src/metering/hash-chain.js';

describe('HashChain', () => {
  it('builds and verifies a hash chain', () => {
    const seed = new TextEncoder().encode('seed');
    const units = [
      new TextEncoder().encode('one'),
      new TextEncoder().encode('two'),
    ];
    const chain = new HashChain(seed);
    for (const unit of units) {
      chain.addUnit(unit);
    }

    const proof = chain.getProof();

    expect(proof.unitCount).toBe(2);
    expect(proof.intermediateHashes).toHaveLength(2);
    expect(HashChain.verifyChain(proof, units, seed)).toBe(true);
  });

  it('detects tampering', () => {
    const seed = new TextEncoder().encode('seed');
    const chain = new HashChain(seed);
    chain.addUnit(new TextEncoder().encode('one'));
    const proof = chain.getProof();

    expect(HashChain.verifyChain(proof, [new TextEncoder().encode('other')], seed)).toBe(false);
  });
});
