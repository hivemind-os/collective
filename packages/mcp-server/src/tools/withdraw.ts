import type { MeshToolContext } from '../context.js';
import { formatMistToSui, formatUsdcBalance } from './balance.js';

export interface MeshWithdrawParams {
  to_address: string;
  amount?: number;
  currency?: string;
}

export const meshWithdrawTool = {
  name: 'collective_withdraw',
  description: 'Withdraw SUI or USDC from the agent wallet to an external address',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to_address: { type: 'string', description: 'Destination Sui address' },
      amount: { type: 'number', description: 'Amount to withdraw (in SUI or USDC units). Omit to withdraw full balance.' },
      currency: { type: 'string', enum: ['SUI', 'USDC'], description: 'Currency to withdraw (default: SUI)' },
    },
    required: ['to_address'],
  },
};

export async function runMeshWithdraw(
  params: MeshWithdrawParams,
  context: MeshToolContext,
): Promise<{ tx_digest: string; amount: string; currency: string; to_address: string }> {
  const currency = (params.currency ?? 'SUI').toUpperCase();
  const address = context.keypair.getPublicKey().toSuiAddress();

  if (currency === 'USDC') {
    return withdrawUsdc(params, context, address);
  }

  return withdrawSui(params, context, address);
}

async function withdrawSui(
  params: MeshWithdrawParams,
  context: MeshToolContext,
  fromAddress: string,
): Promise<{ tx_digest: string; amount: string; currency: string; to_address: string }> {
  const balanceMist = await context.suiClient.getBalance(fromAddress);

  let amountMist: bigint;
  if (params.amount !== undefined) {
    amountMist = BigInt(Math.floor(params.amount * 1_000_000_000));
  } else {
    // Leave some gas for the transaction
    const gasReserve = 10_000_000n;
    amountMist = balanceMist > gasReserve ? balanceMist - gasReserve : 0n;
  }

  if (amountMist <= 0n) {
    throw new Error('Insufficient SUI balance for withdrawal.');
  }

  const { Transaction } = await import('@mysten/sui/transactions');
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  tx.transferObjects([coin], tx.pure.address(params.to_address));

  const response = await context.suiClient.executeTransaction(tx, context.keypair);
  return {
    tx_digest: response.digest,
    amount: formatMistToSui(amountMist),
    currency: 'SUI',
    to_address: params.to_address,
  };
}

async function withdrawUsdc(
  params: MeshWithdrawParams,
  context: MeshToolContext,
  fromAddress: string,
): Promise<{ tx_digest: string; amount: string; currency: string; to_address: string }> {
  const usdcType = context.usdcCoinType;
  if (!usdcType) {
    throw new Error('USDC coin type is not configured for this network.');
  }

  const balance = await context.suiClient.getTokenBalance(fromAddress, usdcType);

  let amountBaseUnits: bigint;
  if (params.amount !== undefined) {
    amountBaseUnits = BigInt(Math.floor(params.amount * 1_000_000));
  } else {
    amountBaseUnits = balance;
  }

  if (amountBaseUnits <= 0n) {
    throw new Error('Insufficient USDC balance for withdrawal.');
  }

  // Get USDC coins owned by the address
  const coins = await context.suiClient.client.getCoins({
    owner: fromAddress,
    coinType: usdcType,
  });

  if (!coins.data.length) {
    throw new Error('No USDC coins found in wallet.');
  }

  const { Transaction } = await import('@mysten/sui/transactions');
  const tx = new Transaction();

  // Merge all USDC coins if there are multiple
  const coinObjectIds = coins.data.map((c) => c.coinObjectId);
  if (coinObjectIds.length > 1) {
    const primaryCoin = tx.object(coinObjectIds[0]!);
    const rest = coinObjectIds.slice(1).map((id) => tx.object(id));
    tx.mergeCoins(primaryCoin, rest);
    const [splitCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountBaseUnits)]);
    tx.transferObjects([splitCoin], tx.pure.address(params.to_address));
  } else {
    const primaryCoin = tx.object(coinObjectIds[0]!);
    const [splitCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountBaseUnits)]);
    tx.transferObjects([splitCoin], tx.pure.address(params.to_address));
  }

  const response = await context.suiClient.executeTransaction(tx, context.keypair);
  return {
    tx_digest: response.digest,
    amount: formatUsdcBalance(amountBaseUnits),
    currency: 'USDC',
    to_address: params.to_address,
  };
}
