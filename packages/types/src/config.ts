import type { DID } from './agent.js';
import type { SpendingPolicy } from './payment.js';

export interface RelayEndpointConfig {
  url: string;
  relayDid?: DID;
}

export interface RelayClientConfig {
  enabled: boolean;
  endpoints: RelayEndpointConfig[];
  autoConnect: boolean;
  providerMode: boolean;
  reconnectIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export interface NetworkConfig {
  rpcUrl: string;
  faucetUrl: string;
  packageId: string;
  registryId: string;
  usdcType?: string;
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

export interface EvmConfig {
  enabled: boolean;
  network: 'base' | 'base-sepolia' | 'localhost';
  rpcUrl?: string;
}

export interface PaymentConfig {
  preferredRail: 'auto' | 'sui' | 'x402';
  evm?: EvmConfig;
}

export interface EncryptionConfig {
  enabled: boolean;
  requireEncryption: boolean;
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
  payment?: PaymentConfig;
  daemon: DaemonConfig;
  relay?: RelayClientConfig;
  blobstore?: BlobStoreConfig;
  encryption?: EncryptionConfig;
}
