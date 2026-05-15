import {
  AggregationMode,
  ProviderSelectionStrategy,
  type AgentCard,
  type MultiProviderRequest,
} from '@agentic-mesh/types';
import {
  CircuitBreaker,
  FanOutExecutor,
  PerformanceTracker,
  ProviderSelector,
} from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';
import { discoverAgentsByCapability } from './discover.js';
import { runMeshExecute } from './execute.js';

const routingCircuitBreaker = new CircuitBreaker();
const routingPerformanceTracker = new PerformanceTracker();
const providerSelector = new ProviderSelector({
  circuitBreaker: routingCircuitBreaker,
  performanceTracker: routingPerformanceTracker,
});

export interface MeshMultiExecuteParams {
  capability: string;
  input: unknown;
  fanOutCount?: number;
  strategy?: ProviderSelectionStrategy | `${ProviderSelectionStrategy}`;
  aggregation?: AggregationMode | `${AggregationMode}`;
  timeout?: number;
  maxPricePerProvider?: number;
}

export const meshMultiExecuteTool = {
  name: 'mesh_multi_execute',
  description: 'Execute a mesh task across multiple providers and aggregate the results',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability name to execute' },
      input: { description: 'Task input payload' },
      fanOutCount: { type: 'number', description: 'How many providers to fan out to (default 3)' },
      strategy: {
        type: 'string',
        enum: Object.values(ProviderSelectionStrategy),
        description: 'Provider selection strategy (default weighted)',
      },
      aggregation: {
        type: 'string',
        enum: Object.values(AggregationMode),
        description: 'Aggregation mode (default first_success)',
      },
      timeout: { type: 'number', description: 'Per-provider timeout in milliseconds' },
      maxPricePerProvider: { type: 'number', description: 'Maximum price per provider in MIST' },
    },
    required: ['capability', 'input'],
  },
};

export interface MeshMultiExecuteResult {
  capability: string;
  strategy: ProviderSelectionStrategy;
  aggregation: AggregationMode;
  providers: Array<{
    did: string;
    price_mist: string;
    reputation: number;
    estimated_latency_ms?: number;
    composite_score: number;
  }>;
  results: Array<{
    provider: string;
    status: 'success' | 'failure' | 'timeout';
    result?: unknown;
    duration_ms: number;
    error?: string;
  }>;
  aggregated_result?: unknown;
  total_cost_mist: string;
}

export async function runMeshMultiExecute(
  params: MeshMultiExecuteParams,
  context: MeshToolContext,
): Promise<MeshMultiExecuteResult> {
  const capability = params.capability.trim();
  if (!capability) {
    throw new Error('Capability is required.');
  }

  const fanOutCount = normalizePositiveInteger(params.fanOutCount, 3);
  const strategy = parseSelectionStrategy(params.strategy);
  const aggregation = parseAggregation(params.aggregation);
  const request: MultiProviderRequest = {
    capability,
    input: params.input,
    fanOutCount,
    strategy,
    aggregation,
    timeout: normalizeOptionalInteger(params.timeout),
    maxPricePerProvider: toOptionalBigInt(params.maxPricePerProvider),
  };

  const { agents: discoveredAgents } = await discoverAgentsByCapability(
    capability,
    context,
    Math.max(fanOutCount * 3, fanOutCount),
    'reputation',
  );
  const candidates = filterByMaxPrice(discoveredAgents, capability, request.maxPricePerProvider);
  const selected = providerSelector.selectProviders(candidates, capability, strategy, fanOutCount);
  if (selected.length === 0) {
    throw new Error(`No eligible providers found for capability ${capability}.`);
  }

  const executor = new FanOutExecutor({
    circuitBreaker: routingCircuitBreaker,
    performanceTracker: routingPerformanceTracker,
    executeProvider: async (provider, executionRequest, executionContext) => {
      if (executionContext.signal.aborted) {
        throw executionContext.signal.reason ?? new Error('Provider execution aborted.');
      }

      const value = await runMeshExecute({
        capability: executionRequest.capability,
        provider_did: provider.did,
        input: serializeInput(executionRequest.input),
        timeout_seconds: executionRequest.timeout ? Math.max(1, Math.ceil(executionRequest.timeout / 1_000)) : undefined,
      }, context);
      return {
        value,
        aggregateValue: value.result,
        cost: BigInt(value.price_mist),
      };
    },
  });

  const result = await executor.execute(request, selected);

  return {
    capability,
    strategy,
    aggregation,
    providers: selected.map((provider) => ({
      did: provider.did,
      price_mist: provider.price.toString(),
      reputation: provider.reputation,
      estimated_latency_ms: provider.estimatedLatency,
      composite_score: provider.compositeScore,
    })),
    results: result.results.map((entry) => ({
      provider: entry.provider,
      status: entry.status,
      result: entry.result,
      duration_ms: entry.durationMs,
      error: entry.error,
    })),
    aggregated_result: result.aggregatedResult,
    total_cost_mist: result.totalCost.toString(),
  };
}

function filterByMaxPrice(agents: AgentCard[], capability: string, maxPricePerProvider?: bigint): AgentCard[] {
  if (maxPricePerProvider === undefined) {
    return agents;
  }

  return agents.filter((agent) => {
    const matched = agent.capabilities.find((entry) => entry.name.toLowerCase() === capability.toLowerCase());
    return matched ? matched.pricing.amount <= maxPricePerProvider : false;
  });
}

function parseSelectionStrategy(strategy?: MeshMultiExecuteParams['strategy']): ProviderSelectionStrategy {
  if (!strategy) {
    return ProviderSelectionStrategy.WEIGHTED;
  }
  if (Object.values(ProviderSelectionStrategy).includes(strategy as ProviderSelectionStrategy)) {
    return strategy as ProviderSelectionStrategy;
  }
  throw new Error(`Unsupported provider selection strategy: ${String(strategy)}.`);
}

function parseAggregation(aggregation?: MeshMultiExecuteParams['aggregation']): AggregationMode {
  if (!aggregation) {
    return AggregationMode.FIRST_SUCCESS;
  }
  if (Object.values(AggregationMode).includes(aggregation as AggregationMode)) {
    return aggregation as AggregationMode;
  }
  throw new Error(`Unsupported aggregation mode: ${String(aggregation)}.`);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeOptionalInteger(value?: number): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function toOptionalBigInt(value?: number): bigint | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  return BigInt(Math.max(0, Math.floor(value)));
}

function serializeInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}
