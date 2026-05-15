import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaymentRail } from '@agentic-mesh/types';

import type { AuthProvider, X402Client } from '../src/index.js';
import { RelayConsumerClient } from '../src/relay/consumer-client.js';

const originalFetch = globalThis.fetch;
const identity = {
  getDID: () => 'did:mesh:consumer',
  toSuiSigner: () => ({
    sign: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }),
} as unknown as AuthProvider;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('RelayConsumerClient', () => {
  it('returns direct sync responses without payment negotiation', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-mesh-response-id': 'task-1',
          'x-mesh-provider': 'did:mesh:provider',
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RelayConsumerClient(null, identity, { relayUrl: 'https://relay.example' });
    const result = await client.executeSync({
      providerDid: 'did:mesh:provider',
      capability: 'echo',
      input: { message: 'hello' },
      paymentRail: PaymentRail.SUI_TRANSFER,
    });

    expect(result.result).toEqual({ ok: true });
    expect(result.taskId).toBe('task-1');
    expect(result.providerDid).toBe('did:mesh:provider');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-mesh-target-provider': 'did:mesh:provider',
      'x-mesh-payment-rail': PaymentRail.SUI_TRANSFER,
      'x-mesh-sequence': '1',
    });
  });

  it('retries x402 challenges with a payment header', async () => {
    const x402Client = {
      parse402Response: vi.fn(() => ({ challenge: true })),
      createPaymentHeader: vi.fn(() => 'signed-x402'),
    } as unknown as X402Client;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            payment: {
              rail: PaymentRail.X402_BASE,
              paymentAddress: '0x0000000000000000000000000000000000000abc',
              amount: '25',
              currency: 'USDC',
              network: 'base-sepolia',
              relayFee: '5',
              expiresAt: Date.now() + 60_000,
              nonce: 'nonce-1',
              extra: { 'payment-required': 'encoded-402' },
            },
          }),
          {
            status: 402,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'payment-response': 'receipt-1',
            'x-mesh-response-id': 'task-2',
          },
        }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RelayConsumerClient(x402Client, identity, { relayUrl: 'https://relay.example' });
    const result = await client.executeSync({
      providerDid: 'did:mesh:provider',
      capability: 'echo',
      input: { message: 'paid' },
      paymentRail: PaymentRail.X402_BASE,
    });

    expect(x402Client.parse402Response).toHaveBeenCalledWith(
      { 'payment-required': 'encoded-402' },
      expect.objectContaining({
        payment: expect.objectContaining({ nonce: 'nonce-1', amount: '25' }),
      }),
    );
    expect(x402Client.createPaymentHeader).toHaveBeenCalledWith({ challenge: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'payment-signature': 'signed-x402',
      'x-mesh-payment-nonce': 'nonce-1',
      'x-mesh-sequence': '2',
    });
    expect(result.paymentReceipt).toBe('receipt-1');
    expect(result.taskId).toBe('task-2');
  });
});
