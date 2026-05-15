import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress, verifyTypedData } from 'viem';

import { PERMIT2_ADDRESS, USDC_ADDRESS } from '../evm/constants.js';
import type { EvmWallet } from '../evm/wallet.js';

const X402_TYPED_DATA_TYPES = {
  PaymentAuthorization: [
    { name: 'payerAddress', type: 'address' },
    { name: 'paymentAddress', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'currency', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

type InternalX402PaymentRequest = X402PaymentRequest & {
  __x402?: {
    x402Version: number;
    requirements: PaymentRequirements;
  };
};

export interface X402PaymentRequest {
  paymentAddress: string;
  amount: string;
  currency: string;
  network: string;
  nonce: string;
  expiresAt: number;
}

export interface X402PaymentSignature {
  signature: string;
  payerAddress: string;
  network: string;
  nonce: string;
}

export class X402Client {
  constructor(private readonly wallet: EvmWallet) {}

  parse402Response(headers: Record<string, string>, body?: unknown): X402PaymentRequest {
    const normalizedHeaders = normalizeHeaders(headers);
    const paymentRequiredHeader = normalizedHeaders['payment-required'];

    if (paymentRequiredHeader) {
      const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
      const requirements = selectRequirement(paymentRequired.accepts, this.wallet.chain.id);
      const request: InternalX402PaymentRequest = {
        paymentAddress: requirements.payTo,
        amount: requirements.amount,
        currency: inferCurrency(requirements),
        network: normalizeNetwork(requirements.network),
        nonce: readString(requirements.extra?.nonce) ?? '',
        expiresAt: readPositiveNumber(requirements.extra?.expiresAt) ?? Date.now() + requirements.maxTimeoutSeconds * 1_000,
        __x402: {
          x402Version: paymentRequired.x402Version,
          requirements,
        },
      };

      return request;
    }

    const payload = extractBodyPayload(body);
    const paymentAddress = readString(payload.paymentAddress) ?? normalizedHeaders['payment-address'];
    const amount = readString(payload.amount) ?? normalizedHeaders['payment-amount'];
    const currency = readString(payload.currency) ?? normalizedHeaders['payment-currency'];
    const network = readString(payload.network) ?? normalizedHeaders['payment-network'];
    const nonce = readString(payload.nonce) ?? normalizedHeaders['payment-nonce'];
    const expiresAt = readPositiveNumber(payload.expiresAt ?? normalizedHeaders['payment-expires-at']);

    if (!paymentAddress || !amount || !currency || !network || !nonce || expiresAt === undefined) {
      throw new Error('402 response did not contain a supported payment challenge.');
    }

    return {
      paymentAddress,
      amount,
      currency,
      network: normalizeNetwork(network),
      nonce,
      expiresAt,
    };
  }

  async signPayment(request: X402PaymentRequest): Promise<X402PaymentSignature> {
    assertNotExpired(request);
    assertWalletMatchesNetwork(this.wallet.chain.id, request.network);

    const signature = await this.wallet.signTypedData(buildTypedData(request, this.wallet.address));

    return {
      signature,
      payerAddress: this.wallet.address,
      network: normalizeNetwork(request.network),
      nonce: request.nonce,
    };
  }

  async createPaymentHeader(request: X402PaymentRequest): Promise<string> {
    const internalRequest = request as InternalX402PaymentRequest;
    if (internalRequest.__x402) {
      const scheme = new ExactEvmScheme({
        address: this.wallet.address as `0x${string}`,
        signTypedData: (message) => this.wallet.signTypedData(message) as Promise<`0x${string}`>,
        readContract: (args) => this.wallet.getPublicClient().readContract(args),
      });
      const { x402Version, requirements } = internalRequest.__x402;
      const result = await scheme.createPaymentPayload(x402Version, requirements);

      return encodePaymentSignatureHeader({
        x402Version: result.x402Version,
        accepted: requirements,
        payload: result.payload,
        extensions: result.extensions,
      });
    }

    const signature = await this.signPayment(request);
    return Buffer.from(JSON.stringify(signature)).toString('base64');
  }

  async verifyPayment(signature: X402PaymentSignature, request: X402PaymentRequest): Promise<boolean> {
    if (Date.now() > request.expiresAt) {
      return false;
    }

    if (normalizeNetwork(signature.network) !== normalizeNetwork(request.network) || signature.nonce !== request.nonce) {
      return false;
    }

    try {
      return await verifyTypedData({
        address: normalizeAddress(signature.payerAddress),
        ...buildTypedData(request, signature.payerAddress),
        signature: signature.signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  }
}

function buildTypedData(request: X402PaymentRequest, payerAddress: string) {
  return {
    domain: {
      name: 'AgenticMeshX402',
      version: '1',
      chainId: getChainId(request.network),
      verifyingContract: normalizeAddress(request.paymentAddress),
    },
    types: X402_TYPED_DATA_TYPES,
    primaryType: 'PaymentAuthorization' as const,
    message: {
      payerAddress: normalizeAddress(payerAddress),
      paymentAddress: normalizeAddress(request.paymentAddress),
      amount: BigInt(request.amount),
      currency: request.currency,
      nonce: request.nonce,
      expiresAt: BigInt(request.expiresAt),
    },
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function extractBodyPayload(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const record = body as Record<string, unknown>;
  if (record.payment && typeof record.payment === 'object') {
    return record.payment as Record<string, unknown>;
  }

  if (record.paymentRequest && typeof record.paymentRequest === 'object') {
    return record.paymentRequest as Record<string, unknown>;
  }

  return record;
}

function selectRequirement(
  accepts: PaymentRequirements | PaymentRequirements[],
  chainId: number,
): PaymentRequirements {
  const requirements = Array.isArray(accepts) ? accepts : [accepts];
  const preferredNetwork = chainIdToNetwork(chainId);
  return requirements.find((entry) => normalizeNetwork(entry.network) === preferredNetwork) ?? requirements[0]!;
}

function inferCurrency(requirements: PaymentRequirements): string {
  const explicit = readString(requirements.extra?.currency) ?? readString(requirements.extra?.symbol);
  if (explicit) {
    return explicit.toUpperCase();
  }

  const network = normalizeNetwork(requirements.network);
  const usdcAddress = network in USDC_ADDRESS ? USDC_ADDRESS[network as keyof typeof USDC_ADDRESS] : undefined;
  if (usdcAddress && normalizeAddress(requirements.asset) === normalizeAddress(usdcAddress)) {
    return 'USDC';
  }

  if (normalizeAddress(requirements.asset) === normalizeAddress(PERMIT2_ADDRESS)) {
    return 'ETH';
  }

  return requirements.asset;
}

function normalizeNetwork(network: string): string {
  const normalized = network.trim().toLowerCase();
  switch (normalized) {
    case 'base':
    case 'eip155:8453':
      return 'base';
    case 'base-sepolia':
    case 'eip155:84532':
      return 'base-sepolia';
    case 'localhost':
    case 'anvil':
    case 'eip155:31337':
      return 'localhost';
    default:
      return normalized;
  }
}

function chainIdToNetwork(chainId: number): string {
  switch (chainId) {
    case 8453:
      return 'base';
    case 84_532:
      return 'base-sepolia';
    case 31_337:
      return 'localhost';
    default:
      return `eip155:${chainId}`;
  }
}

function getChainId(network: string): number {
  switch (normalizeNetwork(network)) {
    case 'base':
      return 8453;
    case 'base-sepolia':
      return 84_532;
    case 'localhost':
      return 31_337;
    default:
      throw new Error(`Unsupported x402 network: ${network}`);
  }
}

function assertNotExpired(request: X402PaymentRequest): void {
  if (Date.now() > request.expiresAt) {
    throw new Error('Payment challenge has expired.');
  }
}

function assertWalletMatchesNetwork(chainId: number, network: string): void {
  const walletNetwork = chainIdToNetwork(chainId);
  const requestNetwork = normalizeNetwork(network);
  if (walletNetwork !== requestNetwork) {
    throw new Error(`Wallet network ${walletNetwork} does not match payment network ${requestNetwork}.`);
  }
}

function normalizeAddress(address: string): `0x${string}` {
  return getAddress(address);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return undefined;
}
