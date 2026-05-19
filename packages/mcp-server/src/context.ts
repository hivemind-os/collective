import type {
  AgentCache,
  AuthProvider,
  BlobStore,
  MeshSuiClient,
  PaymentRailSelector,
  RegistryClient,
  RelayRegistryClient,
  StakingClient,
  DisputeClient,
  MarketplaceClient,
  ReputationEventPublisher,
  ReputationStore,
  SpendingPolicyEngine,
  TaskClient,
  X402Client,
} from '@hivemind-os/collective-core';
import type { DID, NetworkConfig } from '@hivemind-os/collective-types';
import type { Signer } from '@mysten/sui/cryptography';
import type { Logger } from 'pino';

export interface MeshToolContext {
  did: DID;
  keypair: Signer;
  suiClient: MeshSuiClient;
  registryClient: RegistryClient;
  taskClient: TaskClient;
  agentCache: AgentCache;
  blobStore: BlobStore;
  spendingPolicy: SpendingPolicyEngine;
  networkConfig: NetworkConfig;
  /** The name of the MCP client app invoking the tool (for per-app spending). */
  originAppName?: string;
  stakingClient?: StakingClient;
  relayRegistryClient?: RelayRegistryClient;
  disputeClient?: DisputeClient;
  marketplaceClient?: MarketplaceClient;
  encryption?: {
    enabled: boolean;
    requireEncryption: boolean;
    publicKey?: string;
  };
  relayAuthProvider?: AuthProvider;
  authProvider?: AuthProvider;
  x402Client?: X402Client;
  paymentRailSelector?: PaymentRailSelector;
  logger?: Pick<Logger, 'info' | 'warn'>;
  indexer?: {
    enabled?: boolean;
    graphqlUrl?: string;
    fetch?: typeof fetch;
  };
  reputationPublisher?: ReputationEventPublisher;
  reputationStore?: ReputationStore;
  taskHistoryDb?: unknown;
  portalUrl?: string;
  usdcCoinType?: string;
  openUrl?: (url: string) => Promise<boolean>;
  providerConfig?: {
    get: () => ProviderConfigSnapshot;
    set: (config: ProviderConfigSnapshot) => Promise<{ ok: boolean; error?: string }>;
  };
  workQueue?: WorkQueueAccessor;
}

export interface WorkQueueItem {
  id: string;
  taskId: string;
  capability: string;
  inputData: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  resultData?: string;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
}

export interface WorkQueueAccessor {
  poll: () => WorkQueueItem | null;
  complete: (itemId: string, resultData: string) => { ok: boolean; error?: string };
  fail: (itemId: string, error: string) => { ok: boolean; error?: string };
  list: (filter?: { status?: string }) => WorkQueueItem[];
}

export interface ProviderConfigSnapshot {
  enabled: boolean;
  autoRegister: boolean;
  maxConcurrency: number;
  capabilities: Array<{
    name: string;
    description: string;
    version: string;
    priceMist: number;
    currency?: string;
    adapter: string;
    adapterConfig?: Record<string, unknown>;
  }>;
}
