import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitBreakerState } from '../../src/index.js';

describe('CircuitBreaker', () => {
  it('opens after reaching the failure threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    breaker.recordFailure('provider-1');
    breaker.recordFailure('provider-1');
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.CLOSED);

    breaker.recordFailure('provider-1');
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.OPEN);
    expect(breaker.isOpen('provider-1')).toBe(true);
  });

  it('transitions to half-open after the recovery timeout and closes on success', () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 100, now: () => now });

    breaker.recordFailure('provider-1');
    breaker.recordFailure('provider-1');
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.OPEN);

    now += 101;
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.HALF_OPEN);

    breaker.recordSuccess('provider-1');
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.CLOSED);
  });

  it('re-opens immediately when a half-open provider fails', () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50, now: () => now });

    breaker.recordFailure('provider-1');
    breaker.recordFailure('provider-1');
    now += 51;
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.HALF_OPEN);

    breaker.recordFailure('provider-1');
    expect(breaker.getState('provider-1')).toBe(CircuitBreakerState.OPEN);
  });
});
