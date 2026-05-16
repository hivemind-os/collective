import type { NetworkConfig } from '@agentic-mesh/types';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { MeshSuiClient } from '@agentic-mesh/core';

export interface DemoWallet {
  name: string;
  address: string;
  keypair: Ed25519Keypair;
  client: MeshSuiClient;
}

export interface SuiDemo {
  readonly blobStoreDir: string;
  readonly providerCursorDbPath: string;
  readonly networkConfig: NetworkConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
  createFundedWallet(name: string): Promise<DemoWallet>;
  getBalance(address: string): Promise<bigint>;
}
