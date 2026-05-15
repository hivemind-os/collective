import type { DaemonFullConfig } from '../config.js';

export interface ProviderCapabilityConfig {
  name: string;
  description: string;
  version: string;
  priceMist: number;
  currency?: string;
  adapter: string;
  adapterConfig?: Record<string, unknown>;
}

export interface ProviderConfig {
  enabled: boolean;
  capabilities: ProviderCapabilityConfig[];
  maxConcurrency: number;
  autoRegister: boolean;
}

export function loadProviderConfig(config: DaemonFullConfig): ProviderConfig | null {
  if (!config.provider) {
    return null;
  }

  return {
    enabled: config.provider.enabled,
    capabilities: config.provider.capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      version: capability.version,
      priceMist: capability.priceMist,
      currency: capability.currency,
      adapter: capability.adapter,
    })),
    maxConcurrency: Math.max(1, config.provider.maxConcurrency ?? 1),
    autoRegister: config.provider.autoRegister ?? false,
  };
}
