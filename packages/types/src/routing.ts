import type { DID } from './agent.js';

export enum ProviderSelectionStrategy {
  CHEAPEST = 'cheapest',
  FASTEST = 'fastest',
  HIGHEST_REPUTATION = 'highest_reputation',
  ROUND_ROBIN = 'round_robin',
  WEIGHTED = 'weighted',
}

export interface MultiProviderRequest {
  capability: string;
  input: unknown;
  fanOutCount: number;
  strategy: ProviderSelectionStrategy;
  aggregation: AggregationMode;
  timeout?: number;
  maxPricePerProvider?: bigint;
}

export enum AggregationMode {
  FIRST_SUCCESS = 'first_success',
  ALL = 'all',
  MAJORITY = 'majority',
  BEST = 'best',
}

export interface ProviderScore {
  did: DID;
  price: bigint;
  reputation: number;
  estimatedLatency?: number;
  circuitBreakerOpen: boolean;
  compositeScore: number;
}

export interface MultiProviderResult {
  results: Array<{
    provider: DID;
    status: 'success' | 'failure' | 'timeout';
    result?: unknown;
    durationMs: number;
    error?: string;
  }>;
  aggregatedResult?: unknown;
  totalCost: bigint;
}
