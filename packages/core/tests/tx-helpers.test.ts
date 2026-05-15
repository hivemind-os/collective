import { describe, expect, it } from 'vitest';

import {
  buildClaimPaymentTx,
  buildCompleteMeteredTaskTx,
  buildOpenDisputeTx,
  buildPostMeteredTaskTx,
  buildReleaseMeteredPaymentTx,
} from '../src/sui/tx-helpers.js';

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

  it('builds metered task transactions', () => {
    expect(() => buildPostMeteredTaskTx({
      packageId: '0x1',
      registryId: '0x2',
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      agreementHash: 'hash-1',
      maxPriceMist: 10n,
      unitPriceMist: 2n,
      disputeWindowMs: 60_000,
      expiryHours: 24,
    })).not.toThrow();
    expect(() => buildCompleteMeteredTaskTx({
      packageId: '0x1',
      taskId: '0x3',
      resultBlobId: 'blob-2',
      meteredUnits: 2,
      verificationHash: 'aa'.repeat(32),
    })).not.toThrow();
    expect(() => buildReleaseMeteredPaymentTx({
      packageId: '0x1',
      taskId: '0x3',
    })).not.toThrow();
  });

  it('rejects invalid metered completion hashes', () => {
    expect(() => buildCompleteMeteredTaskTx({
      packageId: '0x1',
      taskId: '0x3',
      resultBlobId: 'blob-2',
      meteredUnits: 2,
      verificationHash: 'xyz',
    })).toThrow('verificationHash must be an even-length hex string.');
  });
});
