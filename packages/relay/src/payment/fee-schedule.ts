export interface RelayFeeSchedule {
  basePercentage: number;
  minimumMist: bigint;
}

export interface RelayFeeBreakdown {
  relayFee: bigint;
  totalPrice: bigint;
}

export function calculateRelayFee(basePrice: bigint, feeSchedule: RelayFeeSchedule): RelayFeeBreakdown {
  const computed = (basePrice * BigInt(feeSchedule.basePercentage)) / 100n;
  const relayFee = computed > feeSchedule.minimumMist ? computed : feeSchedule.minimumMist;

  return {
    relayFee,
    totalPrice: basePrice + relayFee,
  };
}
