import { join } from 'node:path';

import {
  DisputeClient,
  MarketplaceClient,
  PaymentRailSelector,
  RelayRegistryClient,
  ReputationEventPublisher,
  ReputationStore,
  StakingClient,
} from '@hivemind-os/collective-core';
import type { MeshToolContext, ProviderConfigSnapshot } from '@hivemind-os/collective-mcp-server';

import { saveConfig, type DaemonFullConfig } from '../config.js';
import type { DaemonState } from '../state.js';

/**
 * Build a {@link MeshToolContext} from daemon state so the
 * `@hivemind-os/collective-mcp-server` tool handlers can run inside the daemon.
 *
 * Optional clients are lazily instantiated on first access to avoid
 * allocating resources (SQLite databases, objects) that may never be used.
 */
export interface ToolContextOptions {
  portalUrl?: string;
  openUrl?: (url: string) => Promise<boolean>;
  config?: DaemonFullConfig;
  configPath?: string;
  onProviderConfigChanged?: () => Promise<void> | void;
}

export function buildMeshToolContext(state: DaemonState, dataDir: string, options?: ToolContextOptions): MeshToolContext {
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
    portalUrl: options?.portalUrl,
    openUrl: options?.openUrl,
  };

  // Provider config accessor — allows MCP tools to read/write provider settings
  if (options?.config && options.configPath) {
    const config = options.config;
    const configPath = options.configPath;
    const onChanged = options.onProviderConfigChanged;

    base.providerConfig = {
      get(): ProviderConfigSnapshot {
        const provider = config.provider;
        return {
          enabled: provider?.enabled ?? false,
          autoRegister: provider?.autoRegister ?? false,
          maxConcurrency: provider?.maxConcurrency ?? 1,
          capabilities: (provider?.capabilities ?? [])
            .filter((c) => c.adapter !== 'local-function')
            .map((c) => ({
              name: c.name,
              description: c.description,
              version: c.version,
              priceMist: c.priceMist,
              currency: c.currency,
              adapter: c.adapter,
              adapterConfig: c.adapterConfig,
            })),
        };
      },
      async set(next: ProviderConfigSnapshot): Promise<{ ok: boolean; error?: string }> {
        const previousProvider = config.provider;
        try {
          config.provider = {
            enabled: next.enabled,
            autoRegister: next.autoRegister,
            maxConcurrency: next.maxConcurrency,
            capabilities: next.capabilities.map((c) => ({
              name: c.name,
              description: c.description,
              version: c.version,
              priceMist: c.priceMist,
              currency: c.currency,
              adapter: c.adapter,
              adapterConfig: c.adapterConfig,
            })),
          };
          await saveConfig(config, configPath);
          await onChanged?.();
          return { ok: true };
        } catch (error) {
          config.provider = previousProvider;
          return { ok: false, error: error instanceof Error ? error.message : 'Failed to save provider config.' };
        }
      },
    };
  }

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
