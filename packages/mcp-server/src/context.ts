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
} from '@agentic-mesh/core';
import type { DID, NetworkConfig } from '@agentic-mesh/types';
import type { Signer } from '@mysten/sui/cryptography';

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
  x402Client?: X402Client;
  paymentRailSelector?: PaymentRailSelector;
  logger?: {
    info?: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
  indexer?: {
    enabled?: boolean;
    graphqlUrl?: string;
    fetch?: typeof fetch;
  };
  reputationPublisher?: ReputationEventPublisher;
  reputationStore?: ReputationStore;
  taskHistoryDb?: unknown;
}
