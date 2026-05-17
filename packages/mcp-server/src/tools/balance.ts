import type { MeshToolContext } from '../context.js';

export const meshBalanceTool = {
  name: 'collective_balance',
  description: 'Get the current wallet balance in SUI and USDC',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export async function runMeshBalance(
  _params: Record<string, never>,
  context: MeshToolContext,
): Promise<{ address: string; balance_mist: string; balance_sui: string; balance_usdc?: string }> {
  const address = context.keypair.getPublicKey().toSuiAddress();
  const balanceMist = await context.suiClient.getBalance(address);

  const result: { address: string; balance_mist: string; balance_sui: string; balance_usdc?: string } = {
    address,
    balance_mist: balanceMist.toString(),
    balance_sui: formatMistToSui(balanceMist),
  };

  const usdcType = context.usdcCoinType;
  if (usdcType) {
    try {
      const usdcRaw = await context.suiClient.getTokenBalance(address, usdcType);
      result.balance_usdc = formatUsdcBalance(usdcRaw);
    } catch {
      // USDC balance unavailable
    }
  }

  return result;
}

export function formatMistToSui(balanceMist: bigint): string {
  const whole = balanceMist / 1_000_000_000n;
  const fraction = balanceMist % 1_000_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

export function formatUsdcBalance(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const fraction = baseUnits % 1_000_000n;
  if (fraction === 0n) {
    return `${whole.toString()} USDC`;
  }

  const fractionText = fraction.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText} USDC`;
}
