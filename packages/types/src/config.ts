import type { DID } from './agent.js';
import type { SpendingPolicy } from './payment.js';

export interface NetworkConfig {
  rpcUrl: string;
  faucetUrl: string;
  packageId: string;
  registryId: string;
}

export interface IdentityConfig {
  did: DID;
  keystorePath?: string;
  keyAlias?: string;
}

export interface DaemonConfig {
  autoStart: boolean;
  ipcPath: string;
  dataDir: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface MeshConfig {
  network: NetworkConfig;
  identity: IdentityConfig;
  spending: SpendingPolicy;
  daemon: DaemonConfig;
}
