import { describe, expect, it } from 'vitest';

import { PaymentRailSelector } from '../../src/index.js';

const selector = new PaymentRailSelector();

describe('PaymentRailSelector', () => {
  it('always chooses Sui escrow for async tasks', () => {
    expect(
      selector.selectRail({
        executionMode: 'async',
        consumerHasSuiWallet: true,
        consumerHasEvmWallet: true,
        providerAcceptsSui: true,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('sui-escrow');
  });

  it('prefers direct Sui settlement for sync tasks when both parties support it', () => {
    expect(
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: true,
        consumerHasEvmWallet: true,
        providerAcceptsSui: true,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('sui-transfer');
  });

  it('falls back to x402 when only EVM payment is available', () => {
    expect(
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: false,
        consumerHasEvmWallet: true,
        providerAcceptsSui: false,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('x402-base');
  });

  it('throws when no payment capability is available', () => {
    expect(() =>
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: false,
        consumerHasEvmWallet: false,
        providerAcceptsSui: false,
        providerAcceptsX402: false,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toThrow('No compatible payment rail is available for this task.');
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
