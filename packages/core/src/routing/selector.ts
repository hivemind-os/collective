import { type AgentCard, type ProviderScore, ProviderSelectionStrategy, type ReputationScore } from '@hivemind-os/collective-types';

import { ReputationScoreCalculator } from '../reputation/score-calculator.js';

import type { CircuitBreaker } from './circuit-breaker.js';
import type { PerformanceTracker } from './performance.js';

export interface ProviderSelectionWeights {
  reputation: number;
  price: number;
  speed: number;
}

export interface ProviderSelectorOptions {
  circuitBreaker?: Pick<CircuitBreaker, 'isOpen'>;
  performanceTracker?: Pick<PerformanceTracker, 'getEstimatedLatency'>;
  reputationCalculator?: ReputationScoreCalculator;
}

const DEFAULT_WEIGHTS: ProviderSelectionWeights = {
  reputation: 0.45,
  price: 0.35,
  speed: 0.2,
};

export class ProviderSelector {
  private readonly circuitBreaker?: Pick<CircuitBreaker, 'isOpen'>;
  private readonly performanceTracker?: Pick<PerformanceTracker, 'getEstimatedLatency'>;
  private readonly reputationCalculator: ReputationScoreCalculator;
  private roundRobinOffset = 0;

  constructor(options: ProviderSelectorOptions = {}) {
    this.circuitBreaker = options.circuitBreaker;
    this.performanceTracker = options.performanceTracker;
    this.reputationCalculator = options.reputationCalculator ?? new ReputationScoreCalculator();
  }

  rankProviders(agents: AgentCard[], capability: string, weights: Partial<ProviderSelectionWeights> = {}): ProviderScore[] {
    const normalizedCapability = capability.trim();
    if (!normalizedCapability) {
      return [];
    }

    const candidates = agents
      .map((agent) => this.toProviderScore(agent, normalizedCapability))
      .filter((entry): entry is ProviderScore => entry !== null);

    return this.applyCompositeScores(candidates, weights).sort((left, right) => right.compositeScore - left.compositeScore);
  }

  selectProviders(
    agents: AgentCard[],
    capability: string,
    strategy: ProviderSelectionStrategy,
    count: number,
    weights: Partial<ProviderSelectionWeights> = {},
  ): ProviderScore[] {
    const ranked = this.rankProviders(agents, capability, weights);
    const available = ranked.filter((entry) => !entry.circuitBreakerOpen);
    const selectedCount = Math.max(1, Math.floor(count));

    switch (strategy) {
      case ProviderSelectionStrategy.CHEAPEST:
        return this.selectCheapest(available, selectedCount);
      case ProviderSelectionStrategy.FASTEST:
        return this.selectFastest(available, selectedCount);
      case ProviderSelectionStrategy.HIGHEST_REPUTATION:
        return this.selectHighestReputation(available, selectedCount);
      case ProviderSelectionStrategy.ROUND_ROBIN:
        return this.selectRoundRobin(available, selectedCount);
      case ProviderSelectionStrategy.WEIGHTED:
      default:
        return this.selectWeighted(available, selectedCount, weights);
    }
  }

  selectCheapest(providers: ProviderScore[], count: number): ProviderScore[] {
    return [...providers]
      .sort((left, right) => compareBigInt(left.price, right.price) || compareNumber(right.reputation, left.reputation))
      .slice(0, count);
  }

  selectFastest(providers: ProviderScore[], count: number): ProviderScore[] {
    return [...providers]
      .sort(
        (left, right) => compareNumber(left.estimatedLatency ?? Number.POSITIVE_INFINITY, right.estimatedLatency ?? Number.POSITIVE_INFINITY)
          || compareNumber(right.reputation, left.reputation),
      )
      .slice(0, count);
  }

  selectHighestReputation(providers: ProviderScore[], count: number): ProviderScore[] {
    return [...providers]
      .sort((left, right) => compareNumber(right.reputation, left.reputation) || compareBigInt(left.price, right.price))
      .slice(0, count);
  }

  selectRoundRobin(providers: ProviderScore[], count: number): ProviderScore[] {
    if (providers.length === 0) {
      return [];
    }

    const start = this.roundRobinOffset % providers.length;
    const rotated = providers.slice(start).concat(providers.slice(0, start));
    this.roundRobinOffset = (this.roundRobinOffset + count) % providers.length;
    return rotated.slice(0, Math.min(count, providers.length));
  }

  selectWeighted(
    providers: ProviderScore[],
    count: number,
    weights: Partial<ProviderSelectionWeights> = {},
  ): ProviderScore[] {
    return this.applyCompositeScores(providers, weights)
      .sort((left, right) => compareNumber(right.compositeScore, left.compositeScore) || compareBigInt(left.price, right.price))
      .slice(0, count);
  }

  private toProviderScore(agent: AgentCard, capability: string): ProviderScore | null {
    const matchedCapability = agent.capabilities.find((entry) => capabilityNameEquals(entry.name, capability));
    if (!matchedCapability) {
      return null;
    }

    const reputationScore = this.reputationCalculator.computeScore(agent, []);
    const scopedScore = getScopedReputation(reputationScore, capability);
    const reputation = scopedScore.successRate * 100 + Math.min(scopedScore.taskCount, 100) * 0.25 - reputationScore.totalDisputes;
    const estimatedLatency = this.performanceTracker?.getEstimatedLatency(agent.did, matchedCapability.name)
      ?? scopedScore.averageLatencyMs
      ?? heuristicLatency(reputation);

    return {
      did: agent.did,
      price: matchedCapability.pricing.amount,
      reputation,
      estimatedLatency,
      circuitBreakerOpen: this.circuitBreaker?.isOpen(agent.did) ?? false,
      compositeScore: 0,
    };
  }

  private applyCompositeScores(
    providers: ProviderScore[],
    weights: Partial<ProviderSelectionWeights>,
  ): ProviderScore[] {
    const normalizedWeights = { ...DEFAULT_WEIGHTS, ...weights };
    const reputations = providers.map((entry) => entry.reputation);
    const prices = providers.map((entry) => entry.price);
    const latencies = providers.map((entry) => entry.estimatedLatency ?? heuristicLatency(entry.reputation));

    return providers.map((provider) => {
      const normalizedReputation = normalizeNumber(provider.reputation, reputations);
      const normalizedPrice = normalizeBigInt(provider.price, prices);
      const normalizedSpeed = 1 - normalizeNumber(provider.estimatedLatency ?? heuristicLatency(provider.reputation), latencies);
      return {
        ...provider,
        compositeScore:
          normalizedWeights.reputation * normalizedReputation
          - normalizedWeights.price * normalizedPrice
          + normalizedWeights.speed * normalizedSpeed,
      };
    });
  }
}

function getScopedReputation(score: ReputationScore, capability: string): { successRate: number; taskCount: number; averageLatencyMs?: number } {
  const scoped = score.capabilityScores[capability]
    ?? Object.entries(score.capabilityScores).find(([entry]) => capabilityNameEquals(entry, capability))?.[1];
  if (scoped) {
    return {
      successRate: scoped.successRate,
      taskCount: scoped.taskCount,
      averageLatencyMs: scoped.averageLatencyMs || undefined,
    };
  }

  return {
    successRate: score.successRate,
    taskCount: score.totalTasks,
    averageLatencyMs: score.averageLatencyMs || undefined,
  };
}

function heuristicLatency(reputation: number): number {
  return Math.max(100, Math.round(1_500 - Math.max(0, reputation) * 10));
}

function capabilityNameEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function normalizeNumber(value: number, values: number[]): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return 0.5;
  }

  return (value - min) / (max - min);
}

function normalizeBigInt(value: bigint, values: bigint[]): number {
  const min = values.reduce((current, entry) => (entry < current ? entry : current), values[0] ?? 0n);
  const max = values.reduce((current, entry) => (entry > current ? entry : current), values[0] ?? 0n);
  if (max === min) {
    return 0.5;
  }

  const scale = 1_000_000n;
  return Number(((value - min) * scale) / (max - min)) / Number(scale);
}
