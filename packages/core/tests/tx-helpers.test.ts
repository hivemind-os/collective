import { describe, expect, it } from 'vitest';

import {
  buildAcceptBidTx,
  buildClaimPaymentTx,
  buildCompleteMeteredTaskTx,
  buildOpenDisputeTx,
  buildPostMeteredTaskTx,
  buildPostTaskTx,
  buildReleaseMeteredPaymentTx,
  buildSlashExpiredEscrowTx,
} from '../src/sui/tx-helpers.js';

function getMoveCalls(tx: { getData: () => { commands: Array<Record<string, unknown>> } }): Array<Record<string, unknown>> {
  return tx.getData().commands
    .filter((command) => 'MoveCall' in command && typeof command.MoveCall === 'object' && command.MoveCall)
    .map((command) => command.MoveCall as Record<string, unknown>);
}

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

  it('adds type arguments to generic task, marketplace, dispute, and slash calls', () => {
    const defaultTaskCall = getMoveCalls(buildPostTaskTx({
      packageId: '0x1',
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      priceMist: 10n,
      disputeWindowMs: 60_000,
      expiryHours: 24,
    }))[0];
    expect(defaultTaskCall?.typeArguments).toEqual(['0x2::sui::SUI']);

    const customCoinType = '0x123::coin::COIN';
    const bidCalls = getMoveCalls(buildAcceptBidTx({
      packageId: '0x1',
      taskId: '0x3',
      bidId: '0x4',
      otherBidIds: ['0x5'],
      coinType: customCoinType,
    }));
    expect(bidCalls).toHaveLength(2);
    expect(bidCalls.map((call) => call.typeArguments)).toEqual([[customCoinType], [customCoinType]]);

    const disputeCall = getMoveCalls(buildOpenDisputeTx({
      packageId: '0x1',
      taskId: '0x3',
      evidenceBlobId: 'walrus:evidence',
      proposedSplitMist: 1n,
      coinType: customCoinType,
    }))[0];
    expect(disputeCall?.typeArguments).toEqual([customCoinType]);

    const slashCall = getMoveCalls(buildSlashExpiredEscrowTx({
      packageId: '0x1',
      stakeId: '0x2',
      taskId: '0x3',
    }))[0];
    expect(slashCall?.typeArguments).toEqual(['0x2::sui::SUI']);
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
