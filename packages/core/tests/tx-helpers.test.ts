import { describe, expect, it } from 'vitest';

import { buildClaimPaymentTx, buildOpenDisputeTx } from '../src/sui/tx-helpers.js';

describe('tx-helpers object id validation', () => {
  it('rejects all-zero object ids while preserving short test ids', () => {
    expect(() => buildClaimPaymentTx({ packageId: '0x1', taskId: '0x3' })).not.toThrow();
    expect(() => buildClaimPaymentTx({ packageId: '0x1', taskId: '0x0' })).toThrow(
      'taskId must be a 0x-prefixed hex object id.',
    );
  });

  it('rejects object ids longer than 32 bytes', () => {
    expect(() => buildClaimPaymentTx({ packageId: `0x${'1'.repeat(65)}`, taskId: '0x3' })).toThrow(
      'packageId must be a 0x-prefixed hex object id.',
    );
  });

  it('rejects zero arbitrator addresses for dispute opening', () => {
    expect(() => buildOpenDisputeTx({
      packageId: '0x1',
      taskId: '0x3',
      evidenceBlobId: 'walrus:evidence',
      proposedSplitMist: 1n,
      arbitratorAddress: '0x0',
    })).toThrow('arbitratorAddress must be a 0x-prefixed hex object id.');
  });
});
