import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaymentRail } from '@hivemind-os/collective-types';

import type { AuthProvider, X402Client } from '../src/index.js';
import { createDID } from '../src/index.js';
import {
  decodeRelaySuiPaymentProof,
  RelayConsumerClient,
  verifyRelaySuiPaymentProof,
} from '../src/relay/consumer-client.js';

type RelaySuiPaymentProof = Parameters<typeof verifyRelaySuiPaymentProof>[0];

const originalFetch = globalThis.fetch;
const validPayerDid = createDID(new Uint8Array(32).fill(1));

const buildRelaySuiPaymentProof = (): RelaySuiPaymentProof => ({
  rail: PaymentRail.SUI_TRANSFER,
  payerDid: validPayerDid,
  payerAddress: '0xpayer',
  paymentAddress: '0xpayment',
  amount: '100',
  currency: 'SUI',
  network: 'testnet',
  nonce: 'nonce-1',
  expiresAt: Date.now() + 60_000,
  signature: '00'.repeat(64),
});

const encodeRelaySuiPaymentProofHeader = (proof: unknown): string =>
  Buffer.from(JSON.stringify(proof), 'utf8').toString('base64');

const identity = {
  getDID: () => 'did:mesh:consumer',
  getAddress: async () => '0xconsumer',
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 500_000])(
    'rejects invalid timeoutMs %p',
    async (timeoutMs) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as typeof fetch;

      const client = new RelayConsumerClient(null, identity, { relayUrl: 'https://relay.example' });
      const expectedMessage = Number.isFinite(timeoutMs) && timeoutMs > 300_000
        ? /exceeds maximum allowed/
        : /Invalid timeoutMs/;

      await expect(client.executeSync({
        providerDid: 'did:mesh:provider',
        capability: 'echo',
        input: { message: 'hello' },
        paymentRail: PaymentRail.SUI_TRANSFER,
        timeoutMs,
      })).rejects.toThrow(expectedMessage);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('maps AbortError to RelayTimeoutError', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn(async () => {
      throw abortError;
    }) as typeof fetch;

    const client = new RelayConsumerClient(null, identity, { relayUrl: 'https://relay.example' });

    await expect(client.executeSync({
      providerDid: 'did:mesh:provider',
      capability: 'echo',
      input: { message: 'hello' },
      paymentRail: PaymentRail.SUI_TRANSFER,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      name: 'RelayTimeoutError',
      message: 'Relay request timed out after 1000ms.',
    });
  });
});

describe('decodeRelaySuiPaymentProof', () => {
  it('rejects invalid base64 headers', () => {
    expect(() => decodeRelaySuiPaymentProof('not-base64!')).toThrow(/valid base64/i);
  });

  it('rejects invalid JSON payloads', () => {
    const header = Buffer.from('{not-json', 'utf8').toString('base64');

    expect(() => decodeRelaySuiPaymentProof(header)).toThrow(/valid json/i);
  });

  it.each(['rail', 'payerDid', 'payerAddress', 'paymentAddress', 'amount', 'currency', 'network', 'nonce', 'expiresAt', 'signature'])(
    'rejects proofs missing %s',
    (field) => {
      const invalidProof = { ...buildRelaySuiPaymentProof() } as Record<string, unknown>;
      delete invalidProof[field];

      expect(() => decodeRelaySuiPaymentProof(encodeRelaySuiPaymentProofHeader(invalidProof))).toThrow(new RegExp(field, 'i'));
    },
  );

  it.each([
    ['rail', { ...buildRelaySuiPaymentProof(), rail: PaymentRail.X402_BASE }, /rail/i],
    ['payerDid', { ...buildRelaySuiPaymentProof(), payerDid: 123 }, /payerDid/i],
    ['expiresAt', { ...buildRelaySuiPaymentProof(), expiresAt: 'soon' }, /expiresAt/i],
  ])('rejects proofs with invalid %s values', (_field, proof, message) => {
    expect(() => decodeRelaySuiPaymentProof(encodeRelaySuiPaymentProofHeader(proof))).toThrow(message);
  });
});

describe('verifyRelaySuiPaymentProof', () => {
  it('rejects invalid hex signatures', () => {
    expect(() => verifyRelaySuiPaymentProof({ ...buildRelaySuiPaymentProof(), signature: 'xyz' })).toThrow(/hex/i);
  });

  it('rejects invalid payer DIDs', () => {
    expect(() => verifyRelaySuiPaymentProof({
      ...buildRelaySuiPaymentProof(),
      payerDid: 'not-a-did' as RelaySuiPaymentProof['payerDid'],
    })).toThrow(/payerDid/i);
  });
});
