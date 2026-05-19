import { describe, expect, it } from 'vitest';

import { PaymentRailSelector } from '../../src/index.js';

const selector = new PaymentRailSelector();
const baseContext = {
  executionMode: 'sync' as const,
  consumerHasSuiWallet: true,
  consumerHasEvmWallet: true,
  providerAcceptsSui: true,
  providerAcceptsX402: true,
  amount: 1n,
  currency: 'USDC',
};

describe('PaymentRailSelector', () => {
  it('always chooses Sui escrow for async tasks', () => {
    expect(
      selector.selectRail({
        ...baseContext,
        executionMode: 'async',
      }),
    ).toBe('sui-escrow');
  });

  it('prefers direct Sui settlement for sync tasks when both parties support it', () => {
    expect(selector.selectRail(baseContext)).toBe('sui-transfer');
  });

  it('falls back to x402 when only EVM payment is available', () => {
    expect(
      selector.selectRail({
        ...baseContext,
        consumerHasSuiWallet: false,
        providerAcceptsSui: false,
      }),
    ).toBe('x402-base');
  });

  it('throws for negative amounts', () => {
    expect(() =>
      selector.selectRail({
        ...baseContext,
        amount: -1n,
      }),
    ).toThrow('Invalid payment amount: -1. Amount must be non-negative.');
  });

  it('throws for empty currencies', () => {
    expect(() =>
      selector.selectRail({
        ...baseContext,
        currency: '   ',
      }),
    ).toThrow('Payment currency is required for rail selection.');
  });

  it('includes payment context when no payment capability is available', () => {
    expect(() =>
      selector.selectRail({
        ...baseContext,
        consumerHasSuiWallet: false,
        consumerHasEvmWallet: false,
        providerAcceptsSui: false,
        providerAcceptsX402: false,
        amount: 7n,
      }),
    ).toThrow(
      'No compatible payment rail is available for 7 USDC (mode: sync, sui: false/false, evm: false/false).',
    );
  });

  it('returns expected rails across wallet/provider combinations', () => {
    const cases = [
      { consumerHasSuiWallet: false, consumerHasEvmWallet: false, providerAcceptsSui: false, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: false, providerAcceptsSui: false, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: true, providerAcceptsSui: false, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: true, providerAcceptsSui: false, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: false, providerAcceptsSui: true, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: false, providerAcceptsSui: true, providerAcceptsX402: false, expected: ['sui-transfer'] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: true, providerAcceptsSui: true, providerAcceptsX402: false, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: true, providerAcceptsSui: true, providerAcceptsX402: false, expected: ['sui-transfer'] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: false, providerAcceptsSui: false, providerAcceptsX402: true, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: false, providerAcceptsSui: false, providerAcceptsX402: true, expected: [] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: true, providerAcceptsSui: false, providerAcceptsX402: true, expected: ['x402-base'] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: true, providerAcceptsSui: false, providerAcceptsX402: true, expected: ['x402-base'] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: false, providerAcceptsSui: true, providerAcceptsX402: true, expected: [] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: false, providerAcceptsSui: true, providerAcceptsX402: true, expected: ['sui-transfer'] },
      { consumerHasSuiWallet: false, consumerHasEvmWallet: true, providerAcceptsSui: true, providerAcceptsX402: true, expected: ['x402-base'] },
      { consumerHasSuiWallet: true, consumerHasEvmWallet: true, providerAcceptsSui: true, providerAcceptsX402: true, expected: ['sui-transfer', 'x402-base'] },
    ] as const;

    for (const testCase of cases) {
      expect(
        selector.getAvailableRails({
          executionMode: 'sync',
          amount: 1n,
          currency: 'USDC',
          ...testCase,
        }),
      ).toEqual(testCase.expected);
    }
  });
});
