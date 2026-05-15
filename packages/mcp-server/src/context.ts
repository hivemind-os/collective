import type {
  AgentCache,
  BlobStore,
  MeshSuiClient,
  RegistryClient,
  SpendingPolicyEngine,
  TaskClient,
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
  taskHistoryDb?: unknown;
}
