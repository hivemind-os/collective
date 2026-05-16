import { describe, expect, it } from 'vitest';

import { AggregationMode, ProviderSelectionStrategy, type MultiProviderRequest, type ProviderScore } from '@hivemind-os/collective-types';

import { CircuitBreaker, FanOutExecutor, PerformanceTracker } from '../../src/index.js';

function createProvider(did: string, price = 5n): ProviderScore {
  return {
    did: did as ProviderScore['did'],
    price,
    reputation: 50,
    estimatedLatency: 100,
    circuitBreakerOpen: false,
    compositeScore: 0,
  };
}

function createRequest(overrides: Partial<MultiProviderRequest> = {}): MultiProviderRequest {
  return {
    capability: 'echo',
    input: { message: 'hello' },
    fanOutCount: 3,
    strategy: ProviderSelectionStrategy.WEIGHTED,
    aggregation: AggregationMode.ALL,
    timeout: 100,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FanOutExecutor', () => {
  it('fans out to all providers and aggregates all successful results', async () => {
    const tracker = new PerformanceTracker();
    const executor = new FanOutExecutor({
      performanceTracker: tracker,
      executeProvider: async (provider) => ({
        value: { provider: provider.did },
        aggregateValue: provider.did,
        cost: provider.price,
      }),
    });

    const result = await executor.execute(createRequest({ aggregation: AggregationMode.ALL, fanOutCount: 2 }), [
      createProvider('did:mesh:a', 2n),
      createProvider('did:mesh:b', 3n),
    ]);

    expect(result.aggregatedResult).toEqual(['did:mesh:a', 'did:mesh:b']);
    expect(result.totalCost).toBe(5n);
    expect(result.results.map((entry) => entry.status)).toEqual(['success', 'success']);
    expect(tracker.getEstimatedLatency('did:mesh:a', 'echo')).toBeDefined();
    tracker.close();
  });

  it('returns the first successful result and aborts slower providers', async () => {
    const breaker = new CircuitBreaker();
    const executor = new FanOutExecutor({
      circuitBreaker: breaker,
      executeProvider: async (provider, _request, context) => {
        if (provider.did === 'did:mesh:fast') {
          await delay(10);
          return { value: { winner: provider.did }, aggregateValue: provider.did, cost: provider.price };
        }

        await new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { value: null, cost: 0n };
      },
    });

    const result = await executor.execute(createRequest({ aggregation: AggregationMode.FIRST_SUCCESS, fanOutCount: 2 }), [
      createProvider('did:mesh:fast', 2n),
      createProvider('did:mesh:slow', 2n),
    ]);

    expect(result.aggregatedResult).toBe('did:mesh:fast');
    expect(result.results.find((entry) => entry.provider === 'did:mesh:fast')?.status).toBe('success');
    expect(result.results.find((entry) => entry.provider === 'did:mesh:slow')?.status).toBe('timeout');
    expect(breaker.getState('did:mesh:fast')).toBe('closed');
  });

  it('returns a majority result when more than half the providers agree', async () => {
    const executor = new FanOutExecutor({
      executeProvider: async (provider) => ({
        value: { provider: provider.did },
        aggregateValue: provider.did === 'did:mesh:c' ? 'different' : 'shared',
        cost: provider.price,
      }),
    });

    const result = await executor.execute(createRequest({ aggregation: AggregationMode.MAJORITY }), [
      createProvider('did:mesh:a'),
      createProvider('did:mesh:b'),
      createProvider('did:mesh:c'),
    ]);

    expect(result.aggregatedResult).toBe('shared');
  });

  it('marks provider timeouts and excludes them from total cost', async () => {
    const executor = new FanOutExecutor({
      executeProvider: async (provider) => {
        if (provider.did === 'did:mesh:slow') {
          await delay(30);
        }
        return { value: provider.did, aggregateValue: provider.did, cost: provider.price };
      },
    });

    const result = await executor.execute(createRequest({ aggregation: AggregationMode.ALL, fanOutCount: 2, timeout: 5 }), [
      createProvider('did:mesh:fast', 2n),
      createProvider('did:mesh:slow', 3n),
    ]);

    expect(result.results.find((entry) => entry.provider === 'did:mesh:fast')?.status).toBe('success');
    expect(result.results.find((entry) => entry.provider === 'did:mesh:slow')?.status).toBe('timeout');
    expect(result.totalCost).toBe(2n);
  });
});
