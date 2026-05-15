import { describe, expect, it } from 'vitest';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { hexToBytes } from 'viem';

import { EvmWallet, USDC_ADDRESS, X402Client, type X402PaymentRequest } from '../../src/index.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PAY_TO = '0x0000000000000000000000000000000000000abc';

function createClient() {
  const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base-sepolia' });
  return new X402Client(wallet);
}

function createManualRequest(overrides: Partial<X402PaymentRequest> = {}): X402PaymentRequest {
  return {
    paymentAddress: PAY_TO,
    amount: '1000000',
    currency: 'USDC',
    network: 'base-sepolia',
    nonce: 'nonce-123',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('X402Client', () => {
  it('parses PAYMENT-REQUIRED headers into a payment request', () => {
    const client = createClient();
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://relay.example.com/task' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          asset: USDC_ADDRESS['base-sepolia'],
          amount: '1000000',
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
          extra: {
            assetTransferMethod: 'permit2',
            currency: 'USDC',
          },
        },
      ],
    });

    const request = client.parse402Response({ 'PAYMENT-REQUIRED': header });

    expect(request).toMatchObject({
      paymentAddress: PAY_TO,
      amount: '1000000',
      currency: 'USDC',
      network: 'base-sepolia',
    });
    expect(request.expiresAt).toBeGreaterThan(Date.now());
  });

  it('signs and verifies payment authorizations', async () => {
    const client = createClient();
    const request = createManualRequest();

    const signature = await client.signPayment(request);

    expect(signature.payerAddress).toBe(PAYER_ADDRESS);
    await expect(client.verifyPayment(signature, request)).resolves.toBe(true);
    await expect(client.verifyPayment(signature, { ...request, amount: '2000000' })).resolves.toBe(false);
  });

  it('creates a standard PAYMENT-SIGNATURE header for x402 challenges', async () => {
    const client = createClient();
    const request = client.parse402Response({
      'payment-required': encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: 'https://relay.example.com/task' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: USDC_ADDRESS['base-sepolia'],
            amount: '1000000',
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
            extra: {
              assetTransferMethod: 'permit2',
              currency: 'USDC',
            },
          },
        ],
      }),
    });

    const header = await client.createPaymentHeader(request);
    const decoded = decodePaymentSignatureHeader(header);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.payTo).toBe(PAY_TO);
    expect(decoded.accepted.amount).toBe('1000000');
    expect(decoded.payload).toHaveProperty('signature');
  });

  it('rejects invalid or expired payment authorizations', async () => {
    const client = createClient();
    const request = createManualRequest();
    const signature = await client.signPayment(request);

    await expect(
      client.verifyPayment({ ...signature, signature: `0x${'0'.repeat(130)}` }, request),
    ).resolves.toBe(false);
    await expect(
      client.signPayment({ ...request, expiresAt: Date.now() - 1 }),
    ).rejects.toThrow('Payment challenge has expired.');
  });
});
