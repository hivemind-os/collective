import type {
  AgentCache,
  BlobStore,
  MeshSuiClient,
  RegistryClient,
  SpendingPolicyEngine,
  TaskClient,
} from '@agentic-mesh/core';
import type { DID, NetworkConfig } from '@agentic-mesh/types';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface MeshToolContext {
  did: DID;
  keypair: Ed25519Keypair;
  suiClient: MeshSuiClient;
  registryClient: RegistryClient;
  taskClient: TaskClient;
  agentCache: AgentCache;
  blobStore: BlobStore;
  spendingPolicy: SpendingPolicyEngine;
  networkConfig: NetworkConfig;
  taskHistoryDb?: unknown;
}
