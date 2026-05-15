import { PaymentRail } from '@agentic-mesh/types';

import type { MeshToolContext } from '../context.js';
import { formatMistToSui } from '../tools/balance.js';

export const meshWalletResource = {
  uri: 'mesh://wallet',
  name: 'Wallet Overview',
  description: 'Current wallet balance and local spending totals',
  mimeType: 'application/json',
};

export async function readWalletResource(context: MeshToolContext): Promise<{
  address: string;
  balance_mist: string;
  balance_sui: string;
  spent_today_mist: string;
  spent_month_mist: string;
  rail: PaymentRail;
}> {
  const address = context.keypair.getPublicKey().toSuiAddress();
  const balance = await context.suiClient.getBalance(address);

  return {
    address,
    balance_mist: balance.toString(),
    balance_sui: formatMistToSui(balance),
    spent_today_mist: context.spendingPolicy.getSpent('day', PaymentRail.SUI_ESCROW).toString(),
    spent_month_mist: context.spendingPolicy.getSpent('month', PaymentRail.SUI_ESCROW).toString(),
    rail: PaymentRail.SUI_ESCROW,
  };
}
