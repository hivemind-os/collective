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
 *
 * Optional clients are lazily instantiated on first access to avoid
 * allocating resources (SQLite databases, objects) that may never be used.
 */
export function buildMeshToolContext(state: DaemonState, dataDir: string): MeshToolContext {
  const base: MeshToolContext = {
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
  };

  // Lazy getters for optional clients — instantiated on first access
  defineLazy(base, 'stakingClient', () => new StakingClient(state.suiClient, { packageId: state.network.packageId }));
  defineLazy(base, 'disputeClient', () => new DisputeClient(state.suiClient, { packageId: state.network.packageId }));
  defineLazy(base, 'marketplaceClient', () => new MarketplaceClient(state.suiClient, state.network));
  defineLazy(base, 'relayRegistryClient', () => new RelayRegistryClient(state.suiClient, { packageId: state.network.packageId }));
  defineLazy(base, 'paymentRailSelector', () => new PaymentRailSelector());
  defineLazy(base, 'reputationPublisher', () => new ReputationEventPublisher(state.blobStore, state.authProvider));
  defineLazy(base, 'reputationStore', () => new ReputationStore(join(dataDir, 'reputation.sqlite')));

  return base;
}

function defineLazy<T extends object, K extends keyof T>(obj: T, key: K, factory: () => T[K]): void {
  let cached: T[K] | undefined;
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: true,
    get() {
      if (cached === undefined) {
        cached = factory();
      }
      return cached;
    },
  });
}
