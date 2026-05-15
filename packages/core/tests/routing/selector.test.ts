import { describe, expect, it } from 'vitest';

import { PaymentRail, ProviderSelectionStrategy, type AgentCard, type ProviderScore } from '@agentic-mesh/types';

import { CircuitBreaker, ProviderSelector } from '../../src/index.js';

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: 'agent-1',
    owner: 'owner-1',
    did: 'did:mesh:agent-1' as AgentCard['did'],
    name: 'Agent 1',
    description: 'Test agent',
    capabilities: [
      {
        name: 'echo',
        description: 'Echo',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 10n,
          currency: 'MIST',
        },
      },
    ],
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createProviderScore(overrides: Partial<ProviderScore> = {}): ProviderScore {
  return {
    did: 'did:mesh:agent-1' as ProviderScore['did'],
    price: 10n,
    reputation: 50,
    estimatedLatency: 500,
    circuitBreakerOpen: false,
    compositeScore: 0,
    ...overrides,
  };
}

describe('ProviderSelector', () => {
  it('selects the cheapest providers first', () => {
    const selector = new ProviderSelector();

    const selected = selector.selectCheapest([
      createProviderScore({ did: 'did:mesh:expensive' as ProviderScore['did'], price: 25n }),
      createProviderScore({ did: 'did:mesh:cheap' as ProviderScore['did'], price: 5n }),
      createProviderScore({ did: 'did:mesh:mid' as ProviderScore['did'], price: 12n }),
    ], 2);

    expect(selected.map((entry) => entry.did)).toEqual(['did:mesh:cheap', 'did:mesh:mid']);
  });

  it('selects the fastest providers using performance data', () => {
    const selector = new ProviderSelector({
      performanceTracker: {
        getEstimatedLatency: (provider) => ({
          'did:mesh:slow': 900,
          'did:mesh:fast': 120,
        }[provider]),
      },
    });

    const selected = selector.selectProviders([
      createAgent({ did: 'did:mesh:slow' as AgentCard['did'], totalTasksCompleted: 10 }),
      createAgent({ did: 'did:mesh:fast' as AgentCard['did'], totalTasksCompleted: 10 }),
    ], 'echo', ProviderSelectionStrategy.FASTEST, 1);

    expect(selected[0]?.did).toBe('did:mesh:fast');
  });

  it('selects the highest reputation providers first', () => {
    const selector = new ProviderSelector();

    const selected = selector.selectProviders([
      createAgent({ did: 'did:mesh:strong' as AgentCard['did'], totalTasksCompleted: 20, totalTasksFailed: 1 }),
      createAgent({ did: 'did:mesh:weak' as AgentCard['did'], totalTasksCompleted: 2, totalTasksFailed: 4 }),
    ], 'echo', ProviderSelectionStrategy.HIGHEST_REPUTATION, 1);

    expect(selected[0]?.did).toBe('did:mesh:strong');
  });

  it('rotates providers with round robin selection', () => {
    const selector = new ProviderSelector();
    const providers = [
      createProviderScore({ did: 'did:mesh:a' as ProviderScore['did'] }),
      createProviderScore({ did: 'did:mesh:b' as ProviderScore['did'] }),
      createProviderScore({ did: 'did:mesh:c' as ProviderScore['did'] }),
    ];

    expect(selector.selectRoundRobin(providers, 2).map((entry) => entry.did)).toEqual(['did:mesh:a', 'did:mesh:b']);
    expect(selector.selectRoundRobin(providers, 2).map((entry) => entry.did)).toEqual(['did:mesh:c', 'did:mesh:a']);
  });

  it('filters out providers with an open circuit breaker before weighted selection', () => {
    const circuitBreaker = new CircuitBreaker();
    circuitBreaker.recordFailure('did:mesh:blocked');
    circuitBreaker.recordFailure('did:mesh:blocked');
    circuitBreaker.recordFailure('did:mesh:blocked');
    const selector = new ProviderSelector({ circuitBreaker });

    const selected = selector.selectProviders([
      createAgent({ did: 'did:mesh:blocked' as AgentCard['did'], totalTasksCompleted: 100 }),
      createAgent({ did: 'did:mesh:healthy' as AgentCard['did'], totalTasksCompleted: 5 }),
    ], 'echo', ProviderSelectionStrategy.WEIGHTED, 2);

    expect(selected.map((entry) => entry.did)).toEqual(['did:mesh:healthy']);
  });
});
