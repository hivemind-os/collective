export enum PaymentRail {
  SUI_ESCROW = 'SUI_ESCROW',
  USDC_ESCROW = 'USDC_ESCROW',
  SUI_TRANSFER = 'SUI_TRANSFER',
  X402_BASE = 'X402_BASE',
}

export interface SpendingLimit {
  amount: bigint;
  interval: 'transaction' | 'hour' | 'day' | 'month' | 'lifetime';
  rail?: PaymentRail;
  currency?: string;
  scope?: string;
}

export interface SpendingPolicy {
  defaultRail?: PaymentRail;
  requireConfirmationAbove?: bigint;
  limits: SpendingLimit[];
  allowlist?: string[];
  denylist?: string[];
}

export interface PricingInfo {
  rail: PaymentRail;
  amount: bigint;
  currency: 'MIST' | 'USDC' | (string & {});
  cadence?: 'flat' | 'per-task' | 'per-second';
  quoteExpiresAt?: number;
}
