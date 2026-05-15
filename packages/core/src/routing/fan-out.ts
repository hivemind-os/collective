import { AggregationMode, type MultiProviderRequest, type MultiProviderResult, type ProviderScore } from '@agentic-mesh/types';

import type { CircuitBreaker } from './circuit-breaker.js';
import type { PerformanceTracker } from './performance.js';

export interface ProviderExecutionOutput {
  value: unknown;
  aggregateValue?: unknown;
  cost?: bigint;
}

export interface FanOutExecutorOptions {
  executeProvider: (
    provider: ProviderScore,
    request: MultiProviderRequest,
    context: { signal: AbortSignal },
  ) => Promise<ProviderExecutionOutput>;
  circuitBreaker?: Pick<CircuitBreaker, 'allowRequest' | 'recordSuccess' | 'recordFailure'>;
  performanceTracker?: Pick<PerformanceTracker, 'recordCompletion'>;
  now?: () => number;
}

interface ExecutionOutcome {
  provider: ProviderScore;
  status: 'success' | 'failure' | 'timeout';
  durationMs: number;
  result?: ProviderExecutionOutput;
  error?: string;
}

export class FanOutExecutor {
  private readonly now: () => number;

  constructor(private readonly options: FanOutExecutorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async execute(request: MultiProviderRequest, providers: ProviderScore[]): Promise<MultiProviderResult> {
    const selectedProviders = providers.slice(0, Math.max(1, Math.floor(request.fanOutCount)));
    if (selectedProviders.length === 0) {
      return {
        results: [],
        totalCost: 0n,
      };
    }

    const controllers = new Map<string, AbortController>();
    const runPromises = selectedProviders.map((provider) => {
      const controller = new AbortController();
      controllers.set(provider.did, controller);
      return this.runProvider(provider, request, controller.signal);
    });

    let aggregatedResult: unknown;

    switch (request.aggregation) {
      case AggregationMode.FIRST_SUCCESS: {
        const firstSuccess = await this.waitForFirstSuccess(runPromises);
        if (firstSuccess) {
          aggregatedResult = firstSuccess.result?.aggregateValue ?? firstSuccess.result?.value;
          abortRemaining(controllers, firstSuccess.provider.did);
        }
        break;
      }
      case AggregationMode.MAJORITY: {
        const majority = await this.waitForMajority(runPromises, selectedProviders.length);
        if (majority) {
          aggregatedResult = majority.result?.aggregateValue ?? majority.result?.value;
          abortRemaining(controllers, majority.provider.did);
        }
        break;
      }
      case AggregationMode.ALL:
      case AggregationMode.BEST:
      default:
        break;
    }

    const outcomes = await Promise.all(runPromises);
    const orderedOutcomes = selectedProviders.map(
      (provider) => outcomes.find((entry) => entry.provider.did === provider.did) ?? {
        provider,
        status: 'timeout' as const,
        durationMs: 0,
        error: 'Provider execution did not complete.',
      },
    );

    if (request.aggregation === AggregationMode.ALL) {
      aggregatedResult = orderedOutcomes
        .filter((entry) => entry.status === 'success')
        .map((entry) => entry.result?.aggregateValue ?? entry.result?.value);
    }

    if (request.aggregation === AggregationMode.BEST) {
      const fastest = orderedOutcomes
        .filter((entry): entry is ExecutionOutcome & { result: ProviderExecutionOutput } => entry.status === 'success' && entry.result !== undefined)
        .sort((left, right) => left.durationMs - right.durationMs)[0];
      aggregatedResult = fastest?.result.aggregateValue ?? fastest?.result.value;
    }

    const totalCost = orderedOutcomes.reduce((sum, entry) => sum + (entry.status === 'success' ? entry.result?.cost ?? 0n : 0n), 0n);

    return {
      results: orderedOutcomes.map((entry) => ({
        provider: entry.provider.did,
        status: entry.status,
        result: entry.result?.value,
        durationMs: entry.durationMs,
        error: entry.error,
      })),
      aggregatedResult,
      totalCost,
    };
  }

  private async runProvider(
    provider: ProviderScore,
    request: MultiProviderRequest,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const startedAt = this.now();
    if (this.options.circuitBreaker?.allowRequest && !this.options.circuitBreaker.allowRequest(provider.did)) {
      return {
        provider,
        status: 'timeout',
        durationMs: 0,
        error: 'Provider circuit breaker is not ready to accept a probe request.',
      };
    }

    try {
      const result = await executeWithControls(
        this.options.executeProvider(provider, request, { signal }),
        signal,
        request.timeout,
      );
      const durationMs = this.now() - startedAt;
      this.options.circuitBreaker?.recordSuccess(provider.did);
      this.options.performanceTracker?.recordCompletion(provider.did, request.capability, durationMs, true);
      return {
        provider,
        status: 'success',
        durationMs,
        result,
      };
    } catch (error) {
      const durationMs = this.now() - startedAt;
      const status = classifyFailure(error);
      const wasCancelled = signal.aborted && status === 'timeout';
      if (!wasCancelled) {
        this.options.circuitBreaker?.recordFailure(provider.did);
        this.options.performanceTracker?.recordCompletion(provider.did, request.capability, durationMs, false);
      }
      return {
        provider,
        status,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async waitForFirstSuccess(outcomes: Array<Promise<ExecutionOutcome>>): Promise<ExecutionOutcome | undefined> {
    const pending = [...outcomes];
    while (pending.length > 0) {
      const next = await Promise.race(pending.map(async (entry, index) => ({ index, value: await entry })));
      if (next.value.status === 'success') {
        return next.value;
      }
      pending.splice(next.index, 1);
    }

    return undefined;
  }

  private async waitForMajority(outcomes: Array<Promise<ExecutionOutcome>>, totalProviders: number): Promise<ExecutionOutcome | undefined> {
    const pending = [...outcomes];
    const buckets = new Map<string, { count: number; outcome: ExecutionOutcome }>();
    const threshold = Math.floor(totalProviders / 2) + 1;

    while (pending.length > 0) {
      const next = await Promise.race(pending.map(async (entry, index) => ({ index, value: await entry })));
      pending.splice(next.index, 1);
      if (next.value.status !== 'success' || !next.value.result) {
        continue;
      }

      const hash = stableStringify(next.value.result.aggregateValue ?? next.value.result.value);
      const current = buckets.get(hash) ?? { count: 0, outcome: next.value };
      current.count += 1;
      buckets.set(hash, current);
      if (current.count >= threshold) {
        return current.outcome;
      }
    }

    return undefined;
  }
}

function abortRemaining(controllers: Map<string, AbortController>, winningDid: string): void {
  for (const [providerDid, controller] of controllers.entries()) {
    if (providerDid !== winningDid) {
      controller.abort(new Error('Aborted after aggregate result was determined.'));
    }
  }
}

function classifyFailure(error: unknown): 'failure' | 'timeout' {
  if (error instanceof Error && /timed out|aborted/i.test(error.message)) {
    return 'timeout';
  }
  return 'failure';
}

async function executeWithControls<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new Error('Provider execution aborted.');
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Provider execution aborted.'));
    };
    const timer = typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`Provider request timed out after ${timeoutMs}ms.`));
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer) {
        clearTimeout(timer);
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}
