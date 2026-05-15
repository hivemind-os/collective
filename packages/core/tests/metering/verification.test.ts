import { describe, expect, it } from 'vitest';

import { HashChain } from '../../src/metering/hash-chain.js';
import { ResultVerifier, createMeteredResultEnvelope, decodeMeteredResult, getMeteredResultUnits, parseMeteredResultEnvelope, serializeMeteredResultEnvelope } from '../../src/metering/verification.js';

describe('ResultVerifier', () => {
  it('verifies metered result envelopes against task hashes', () => {
    const seed = new TextEncoder().encode('agentic-mesh:metering:v1:task-1');
    const chain = new HashChain(seed);
    const units = [
      new TextEncoder().encode('chunk-a'),
      new TextEncoder().encode('chunk-b'),
    ];
    for (const unit of units) {
      chain.addUnit(unit);
    }

    const proof = chain.getProof();
    const envelope = createMeteredResultEnvelope(new Uint8Array(Buffer.concat(units.map((unit) => Buffer.from(unit)))), proof, 7);
    const parsed = parseMeteredResultEnvelope(serializeMeteredResultEnvelope(envelope));
    const verifier = new ResultVerifier();

    expect(parsed).not.toBeNull();
    expect(Buffer.from(decodeMeteredResult(parsed!)).toString('utf8')).toBe('chunk-achunk-b');
    expect(verifier.verify({ id: 'task-1', verificationHash: proof.root }, parsed!.proof, getMeteredResultUnits(parsed!))).toBe(true);
  });
});
