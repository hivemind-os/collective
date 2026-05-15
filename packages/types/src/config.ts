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

export interface AuthConfig {
  mode: 'ed25519' | 'zklogin';
  google?: {
    clientId: string;
  };
  apple?: {
    clientId: string;
  };
  portal?: {
    port: number;
  };
}

export interface BlobStoreConfig {
  mode: 'filesystem' | 'walrus' | 'hybrid';
  filesystem?: {
    dataDir: string;
  };
  walrus?: {
    publisherUrl: string;
    aggregatorUrl: string;
    epochs?: number;
    maxBlobSize?: number;
    retryAttempts?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
  };
  hybrid?: {
    cacheLocally: boolean;
    preferWalrus: boolean;
  };
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
  auth?: AuthConfig;
  spending: SpendingPolicy;
  daemon: DaemonConfig;
  blobstore?: BlobStoreConfig;
}
