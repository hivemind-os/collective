import type { MeshToolContext } from '../context.js';

export const meshBalanceTool = {
  name: 'collective_balance',
  description: 'Get the current wallet balance in MIST and SUI',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export async function runMeshBalance(
  _params: Record<string, never>,
  context: MeshToolContext,
): Promise<{ address: string; balance_mist: string; balance_sui: string }> {
  const address = context.keypair.getPublicKey().toSuiAddress();
  const balanceMist = await context.suiClient.getBalance(address);

  return {
    address,
    balance_mist: balanceMist.toString(),
    balance_sui: formatMistToSui(balanceMist),
  };
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
