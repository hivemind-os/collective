import { describe, expect, it, vi } from 'vitest';

import { EvmWallet, X402Client } from '@hivemind-os/collective-core';
import { PaymentRail } from '@hivemind-os/collective-types';
import { hexToBytes } from 'viem';

import { PaymentGate } from '../src/payment/payment-gate.js';

const provider = {
  sessionId: 'session-1',
  providerDid: 'did:mesh:provider',
  ws: {} as never,
  capabilities: ['echo'],
  connectedAt: 0,
  lastHeartbeat: 0,
  sequenceCounter: 0,
};

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('PaymentGate', () => {
  it('generates x402 challenges and verifies them through the injected verifier', async () => {
    const verifyPaymentProof = vi.fn(async () => ({
      accepted: true,
      settlementReference: 'receipt-1',
      payer: '0x0000000000000000000000000000000000000abc',
    }));
    const gate = new PaymentGate({
      relayDid: 'did:mesh:relay',
      feeSchedule: { basePercentage: 0, minimumMist: 0n },
      now: () => 1_000,
      nonceFactory: () => 'nonce-1',
      basePriceResolver: () => 25n,
      verifyPaymentProof,
    });

    const challenge = gate.generate402Challenge(PaymentRail.X402_BASE, 'echo', provider as never);
    const verification = await gate.verifyPayment('payment-proof', challenge);

    expect(challenge.rail).toBe(PaymentRail.X402_BASE);
    expect(challenge.amount).toBe('25');
    expect(challenge.network).toBe('base-sepolia');
    expect(challenge.extra?.['payment-required']).toBeTruthy();
    expect(verifyPaymentProof).toHaveBeenCalledWith('payment-proof', challenge);
    expect(verification.accepted).toBe(true);
    expect(verification.settlementReference).toBe('receipt-1');
  });

  it('rejects replayed x402 payment proofs across different relay challenges', async () => {
    const now = Date.now();
    const gate = new PaymentGate({
      relayDid: 'did:mesh:relay',
      feeSchedule: { basePercentage: 0, minimumMist: 0n },
      now: () => now,
      nonceFactory: vi.fn().mockReturnValueOnce('nonce-1').mockReturnValueOnce('nonce-2'),
      basePriceResolver: () => 25n,
    });
    const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base-sepolia' });
    const x402Client = new X402Client(wallet);

    const firstChallenge = gate.generate402Challenge(PaymentRail.X402_BASE, 'echo', provider as never);
    const paymentRequest = x402Client.parse402Response(
      firstChallenge.extra?.['payment-required'] ? { 'payment-required': firstChallenge.extra['payment-required'] } : {},
      { payment: firstChallenge },
    );
    const paymentHeader = await x402Client.createPaymentHeader(paymentRequest);

    await expect(gate.verifyPayment(paymentHeader, firstChallenge)).resolves.toMatchObject({ accepted: true });

    const secondChallenge = gate.generate402Challenge(PaymentRail.X402_BASE, 'echo', provider as never);
    await expect(gate.verifyPayment(paymentHeader, secondChallenge)).resolves.toMatchObject({
      accepted: false,
      reason: 'Payment proof has already been used.',
    });
  });
});
