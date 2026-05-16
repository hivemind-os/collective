import { join } from 'node:path';

import {
  DisputeClient,
  MarketplaceClient,
  PaymentRailSelector,
  RelayRegistryClient,
  ReputationEventPublisher,
  ReputationStore,
  StakingClient,
} from '@agentic-mesh/core';
import type { MeshToolContext } from '@agentic-mesh/mcp-server';

import type { DaemonState } from '../state.js';

/**
 * Build a {@link MeshToolContext} from daemon state so the
 * `@agentic-mesh/mcp-server` tool handlers can run inside the daemon.
 */
export function buildMeshToolContext(state: DaemonState, dataDir: string): MeshToolContext {
  const stakingClient = new StakingClient(state.suiClient, { packageId: state.network.packageId });
  const disputeClient = new DisputeClient(state.suiClient, { packageId: state.network.packageId });
  const marketplaceClient = new MarketplaceClient(state.suiClient, state.network);
  const relayRegistryClient = new RelayRegistryClient(state.suiClient, { packageId: state.network.packageId });
  const paymentRailSelector = new PaymentRailSelector();
  const reputationPublisher = new ReputationEventPublisher(state.blobStore, state.authProvider);
  const reputationStore = new ReputationStore(join(dataDir, 'reputation.sqlite'));

  return {
    did: state.did,
    keypair: state.keypair,
    suiClient: state.suiClient,
    registryClient: state.registryClient,
    taskClient: state.taskClient,
    agentCache: state.agentCache,
    blobStore: state.blobStore,
    spendingPolicy: state.spendingPolicy,
    networkConfig: state.network,
    encryption: state.encryption,
    authProvider: state.authProvider,
    relayAuthProvider: state.relayAuthProvider,
    x402Client: state.x402Client,
    stakingClient,
    disputeClient,
    marketplaceClient,
    relayRegistryClient,
    paymentRailSelector,
    reputationPublisher,
    reputationStore,
  };
}
