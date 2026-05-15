import { randomUUID } from 'node:crypto';

import {
  decodeRelaySuiPaymentProof,
  verifyRelaySuiPaymentProof,
  USDC_ADDRESS,
} from '@agentic-mesh/core';
import { PaymentRail } from '@agentic-mesh/types';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { PERMIT2_ADDRESS, permit2WitnessTypes, x402ExactPermit2ProxyAddress } from '@x402/evm';
import { getAddress, verifyTypedData } from 'viem';

import type { ProviderSession } from '../routing/session-manager.js';
import { calculateRelayFee, type RelayFeeBreakdown, type RelayFeeSchedule } from './fee-schedule.js';

const DEFAULT_X402_NETWORK = 'base-sepolia';
const DEFAULT_EVM_PAYMENT_ADDRESS = '0x0000000000000000000000000000000000000abc';

export interface PaymentChallenge {
  rail: PaymentRail;
  paymentAddress: string;
  amount: string;
  currency: string;
  network: string;
  relayFee: string;
  expiresAt: number;
  nonce: string;
  asset?: string;
  extra?: Record<string, string>;
}

export interface PaymentVerification {
  accepted: boolean;
  settlementReference?: string;
  relayFee?: string;
  totalPrice?: string;
  payer?: string;
  reason?: string;
}

export interface PaymentGateOptions {
  relayDid: string;
  feeSchedule: RelayFeeSchedule;
  paymentAddress?: string;
  evmPaymentAddress?: string;
  defaultRail?: PaymentRail;
  challengeTtlMs?: number;
  now?: () => number;
  nonceFactory?: () => string;
  basePriceResolver?: (capability: string, provider: ProviderSession) => bigint;
  verifyPaymentProof?: (paymentHeader: string, challenge: PaymentChallenge) => Promise<PaymentVerification>;
}

interface Permit2Authorization {
  from: string;
  permitted: {
    token: string;
    amount: string;
  };
  spender: string;
  nonce: string;
  deadline: string;
  witness: {
    to: string;
    validAfter: string;
  };
}

interface Permit2Payload {
  signature: `0x${string}`;
  permit2Authorization: Permit2Authorization;
}

interface PaymentReplayMetadata {
  key: string;
  expiresAt: number;
}

export class PaymentGate {
  private readonly activeChallenges = new Map<string, PaymentChallenge>();
  private readonly consumedProofs = new Map<string, number>();
  private readonly now: () => number;
  private readonly nonceFactory: () => string;
  private readonly basePriceResolver: (capability: string, provider: ProviderSession) => bigint;
  readonly defaultRail: PaymentRail;

  constructor(private readonly options: PaymentGateOptions) {
    this.now = options.now ?? (() => Date.now());
    this.nonceFactory = options.nonceFactory ?? (() => randomUUID());
    this.basePriceResolver = options.basePriceResolver ?? (() => 0n);
    this.defaultRail = options.defaultRail ?? PaymentRail.SUI_TRANSFER;
  }

  generate402Challenge(rail: PaymentRail, capability: string, provider: ProviderSession): PaymentChallenge {
    const basePrice = this.basePriceResolver(capability, provider);
    const fee = this.calculateFee(basePrice);
    const nonce = this.nonceFactory();
    const expiresAt = this.now() + (this.options.challengeTtlMs ?? 60_000);

    const challenge =
      rail === PaymentRail.X402_BASE
        ? this.createX402Challenge(fee, nonce, expiresAt)
        : this.createSuiChallenge(rail, fee, nonce, expiresAt);

    this.activeChallenges.set(challenge.nonce, challenge);
    return challenge;
  }

  getChallenge(nonce: string): PaymentChallenge | null {
    return this.activeChallenges.get(nonce) ?? null;
  }

  isChallengeExpired(challenge: PaymentChallenge): boolean {
    return challenge.expiresAt <= this.now();
  }

  async verifyPayment(paymentHeader: string, challenge: PaymentChallenge): Promise<PaymentVerification> {
    this.pruneConsumedProofs();

    if (!this.activeChallenges.has(challenge.nonce)) {
      return {
        accepted: false,
        reason: 'Unknown payment challenge.',
      };
    }

    if (this.isChallengeExpired(challenge)) {
      this.activeChallenges.delete(challenge.nonce);
      return {
        accepted: false,
        reason: 'Payment challenge expired.',
      };
    }

    const replayMetadata = getPaymentReplayMetadata(paymentHeader, challenge);
    if (replayMetadata && this.consumedProofs.has(replayMetadata.key)) {
      return {
        accepted: false,
        reason: 'Payment proof has already been used.',
      };
    }

    const verifier = this.options.verifyPaymentProof;
    const verification = verifier
      ? await verifier(paymentHeader, challenge)
      : await this.verifyChallenge(paymentHeader, challenge);

    if (verification.accepted) {
      this.activeChallenges.delete(challenge.nonce);
      if (replayMetadata) {
        this.consumedProofs.set(replayMetadata.key, replayMetadata.expiresAt);
      }
    }

    return verification;
  }

  calculateFee(basePrice: bigint): RelayFeeBreakdown {
    return calculateRelayFee(basePrice, this.options.feeSchedule);
  }

  pruneExpiredChallenges(): number {
    this.pruneConsumedProofs();

    let removed = 0;
    for (const challenge of this.activeChallenges.values()) {
      if (!this.isChallengeExpired(challenge)) {
        continue;
      }

      this.activeChallenges.delete(challenge.nonce);
      removed += 1;
    }

    return removed;
  }

  private pruneConsumedProofs(): void {
    const now = this.now();
    for (const [replayKey, expiresAt] of this.consumedProofs.entries()) {
      if (expiresAt > now) {
        continue;
      }

      this.consumedProofs.delete(replayKey);
    }
  }

  private createSuiChallenge(
    rail: PaymentRail,
    fee: RelayFeeBreakdown,
    nonce: string,
    expiresAt: number,
  ): PaymentChallenge {
    return {
      rail,
      paymentAddress: this.options.paymentAddress ?? this.options.relayDid,
      amount: fee.totalPrice.toString(),
      currency: 'MIST',
      network: 'sui',
      relayFee: fee.relayFee.toString(),
      expiresAt,
      nonce,
    };
  }

  private createX402Challenge(fee: RelayFeeBreakdown, nonce: string, expiresAt: number): PaymentChallenge {
    const network = DEFAULT_X402_NETWORK;
    const asset = USDC_ADDRESS[network];
    const paymentAddress = this.options.evmPaymentAddress ?? DEFAULT_EVM_PAYMENT_ADDRESS;
    const paymentRequiredHeader = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://relay.agentic-mesh.local/execute' },
      accepts: [
        {
          scheme: 'exact',
          network: toCaip2Network(network),
          asset,
          amount: fee.totalPrice.toString(),
          payTo: paymentAddress,
          maxTimeoutSeconds: Math.max(1, Math.ceil((expiresAt - this.now()) / 1_000)),
          extra: {
            assetTransferMethod: 'permit2',
            currency: 'USDC',
            nonce,
            expiresAt: String(expiresAt),
          },
        },
      ],
    });

    return {
      rail: PaymentRail.X402_BASE,
      paymentAddress,
      amount: fee.totalPrice.toString(),
      currency: 'USDC',
      network,
      relayFee: fee.relayFee.toString(),
      expiresAt,
      nonce,
      asset,
      extra: {
        assetTransferMethod: 'permit2',
        currency: 'USDC',
        nonce,
        expiresAt: String(expiresAt),
        'payment-required': paymentRequiredHeader,
      },
    };
  }

  private async verifyChallenge(paymentHeader: string, challenge: PaymentChallenge): Promise<PaymentVerification> {
    switch (challenge.rail) {
      case PaymentRail.X402_BASE:
        return verifyX402Payment(paymentHeader, challenge);
      case PaymentRail.SUI_TRANSFER:
      case PaymentRail.SUI_ESCROW:
        return verifySuiPayment(paymentHeader, challenge);
      default:
        return {
          accepted: false,
          reason: `Unsupported payment rail: ${String(challenge.rail)}`,
        };
    }
  }
}

async function verifyX402Payment(paymentHeader: string, challenge: PaymentChallenge): Promise<PaymentVerification> {
  try {
    const payment = decodePaymentSignatureHeader(paymentHeader);
    const accepted = payment.accepted;
    if (
      accepted.scheme !== 'exact' ||
      accepted.amount !== challenge.amount ||
      normalizeNetwork(accepted.network) !== normalizeNetwork(toCaip2Network(challenge.network)) ||
      getAddress(accepted.payTo) !== getAddress(challenge.paymentAddress) ||
      (challenge.asset && getAddress(accepted.asset) !== getAddress(challenge.asset))
    ) {
      return {
        accepted: false,
        reason: 'x402 payment requirements did not match the relay challenge.',
      };
    }

    if (!hasPermit2Authorization(payment.payload)) {
      return {
        accepted: false,
        reason: 'Only Permit2 x402 payments are currently supported by the relay.',
      };
    }

    const authorization = payment.payload.permit2Authorization;
    const verified = await verifyTypedData({
      address: getAddress(authorization.from),
      domain: {
        name: 'Permit2',
        chainId: toChainId(challenge.network),
        verifyingContract: PERMIT2_ADDRESS,
      },
      types: permit2WitnessTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: {
          token: getAddress(authorization.permitted.token),
          amount: BigInt(authorization.permitted.amount),
        },
        spender: getAddress(authorization.spender),
        nonce: BigInt(authorization.nonce),
        deadline: BigInt(authorization.deadline),
        witness: {
          to: getAddress(authorization.witness.to),
          validAfter: BigInt(authorization.witness.validAfter),
        },
      },
      signature: payment.payload.signature,
    });

    const deadlineMs = deadlineToTimestampMs(authorization.deadline);
    if (
      !verified ||
      getAddress(authorization.witness.to) !== getAddress(challenge.paymentAddress) ||
      getAddress(authorization.permitted.token) !== getAddress(challenge.asset ?? authorization.permitted.token) ||
      authorization.permitted.amount !== challenge.amount ||
      getAddress(authorization.spender) !== getAddress(x402ExactPermit2ProxyAddress) ||
      deadlineMs === null ||
      deadlineMs > challenge.expiresAt + 1_000
    ) {
      return {
        accepted: false,
        reason: 'x402 payment signature verification failed.',
      };
    }

    return {
      accepted: true,
      payer: authorization.from,
      settlementReference: encodePaymentResponseHeader({
        success: true,
        transaction: `x402-${challenge.nonce}`,
        network: toCaip2Network(challenge.network),
        amount: challenge.amount,
        payer: authorization.from,
      }),
      relayFee: challenge.relayFee,
      totalPrice: challenge.amount,
    };
  } catch (error) {
    return {
      accepted: false,
      reason: error instanceof Error ? error.message : 'x402 payment verification failed.',
    };
  }
}

async function verifySuiPayment(paymentHeader: string, challenge: PaymentChallenge): Promise<PaymentVerification> {
  try {
    const proof = decodeRelaySuiPaymentProof(paymentHeader);
    if (
      proof.amount !== challenge.amount ||
      proof.nonce !== challenge.nonce ||
      proof.currency !== challenge.currency ||
      proof.network !== challenge.network ||
      proof.paymentAddress !== challenge.paymentAddress ||
      proof.expiresAt !== challenge.expiresAt
    ) {
      return {
        accepted: false,
        reason: 'Sui payment proof did not match the relay challenge.',
      };
    }

    if (!verifyRelaySuiPaymentProof(proof)) {
      return {
        accepted: false,
        reason: 'Sui payment proof signature verification failed.',
      };
    }

    return {
      accepted: true,
      payer: proof.payerAddress,
      settlementReference: JSON.stringify({
        rail: challenge.rail,
        nonce: challenge.nonce,
        payerDid: proof.payerDid,
        payerAddress: proof.payerAddress,
      }),
      relayFee: challenge.relayFee,
      totalPrice: challenge.amount,
    };
  } catch (error) {
    return {
      accepted: false,
      reason: error instanceof Error ? error.message : 'Sui payment proof verification failed.',
    };
  }
}

function hasPermit2Authorization(value: unknown): value is Permit2Payload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { signature?: unknown; permit2Authorization?: Record<string, unknown> };
  const authorization = candidate.permit2Authorization;
  return Boolean(
    typeof candidate.signature === 'string' &&
      authorization &&
      typeof authorization.from === 'string' &&
      typeof authorization.spender === 'string' &&
      typeof authorization.nonce === 'string' &&
      typeof authorization.deadline === 'string' &&
      typeof authorization.witness === 'object' &&
      typeof authorization.permitted === 'object',
  );
}

function getPaymentReplayMetadata(paymentHeader: string, challenge: PaymentChallenge): PaymentReplayMetadata | null {
  try {
    switch (challenge.rail) {
      case PaymentRail.X402_BASE: {
        const payment = decodePaymentSignatureHeader(paymentHeader);
        if (!hasPermit2Authorization(payment.payload)) {
          return null;
        }

        const expiresAt = deadlineToTimestampMs(payment.payload.permit2Authorization.deadline) ?? challenge.expiresAt;
        return {
          key: `x402:${payment.payload.signature}`,
          expiresAt,
        };
      }
      case PaymentRail.SUI_TRANSFER:
      case PaymentRail.SUI_ESCROW: {
        const proof = decodeRelaySuiPaymentProof(paymentHeader);
        return {
          key: `sui:${proof.signature}`,
          expiresAt: proof.expiresAt,
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function deadlineToTimestampMs(deadlineSeconds: string): number | null {
  if (!/^\d+$/.test(deadlineSeconds)) {
    return null;
  }

  const deadlineMs = BigInt(deadlineSeconds) * 1_000n;
  if (deadlineMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(deadlineMs);
}

function normalizeNetwork(network: string): string {
  return network.trim().toLowerCase();
}

function toChainId(network: string): number {
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

function toCaip2Network(network: string): `eip155:${string}` {
  return `eip155:${toChainId(network)}`;
}
