export enum PaymentScheme {
  EXACT = 'exact',
  UPTO = 'upto',
  STREAM = 'stream',
}

export interface MeteringConfig {
  scheme: PaymentScheme;
  unitPrice: bigint;
  maxPrice: bigint;
  estimatedUnits?: number;
}

export interface MeteringReport {
  taskId: string;
  actualUnits: number;
  actualCost: bigint;
  maxPrice: bigint;
  refundAmount: bigint;
  verificationHash: string;
}

export interface HashChainProof {
  root: string;
  intermediateHashes: string[];
  unitCount: number;
}

export interface StreamingPaymentState {
  taskId: string;
  totalPaid: bigint;
  maxBudget: bigint;
  currentUnit: number;
  lastPaymentTimestamp: number;
}
