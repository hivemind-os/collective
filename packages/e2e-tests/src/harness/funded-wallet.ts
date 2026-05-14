import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { SuiTestNetwork } from './sui-network.js';

export interface TestWallet {
  address: string;
  keypair: Ed25519Keypair;
  client: SuiClient;
}

export async function createFundedWallet(
  network: SuiTestNetwork,
  amount?: bigint,
): Promise<TestWallet> {
  return network.createFundedWallet(amount);
}
