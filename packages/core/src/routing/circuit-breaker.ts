export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

interface ProviderCircuitState {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenProbeInFlight?: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, ProviderCircuitState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 3));
    this.recoveryTimeoutMs = Math.max(0, Math.floor(options.recoveryTimeoutMs ?? 60_000));
    this.now = options.now ?? (() => Date.now());
  }

  recordSuccess(providerId: string): void {
    this.states.set(providerId, {
      state: CircuitBreakerState.CLOSED,
      consecutiveFailures: 0,
      halfOpenProbeInFlight: false,
    });
  }

  recordFailure(providerId: string): void {
    const current = this.getStateRecord(providerId);
    const nextFailures = current.state === CircuitBreakerState.HALF_OPEN ? this.failureThreshold : current.consecutiveFailures + 1;
    if (nextFailures >= this.failureThreshold) {
      this.states.set(providerId, {
        state: CircuitBreakerState.OPEN,
        consecutiveFailures: nextFailures,
        openedAt: this.now(),
        halfOpenProbeInFlight: false,
      });
      return;
    }

    this.states.set(providerId, {
      state: CircuitBreakerState.CLOSED,
      consecutiveFailures: nextFailures,
      halfOpenProbeInFlight: false,
    });
  }

  allowRequest(providerId: string): boolean {
    const current = this.getStateRecord(providerId);
    if (current.state === CircuitBreakerState.OPEN) {
      return false;
    }
    if (current.state !== CircuitBreakerState.HALF_OPEN) {
      return true;
    }
    if (current.halfOpenProbeInFlight) {
      return false;
    }

    this.states.set(providerId, {
      ...current,
      halfOpenProbeInFlight: true,
    });
    return true;
  }

  isOpen(providerId: string): boolean {
    return this.getState(providerId) === CircuitBreakerState.OPEN;
  }

  getState(providerId: string): CircuitBreakerState {
    return this.getStateRecord(providerId).state;
  }

  private getStateRecord(providerId: string): ProviderCircuitState {
    const existing = this.states.get(providerId) ?? {
      state: CircuitBreakerState.CLOSED,
      consecutiveFailures: 0,
    };

    if (
      existing.state === CircuitBreakerState.OPEN
      && existing.openedAt !== undefined
      && this.now() - existing.openedAt >= this.recoveryTimeoutMs
    ) {
      const recovered: ProviderCircuitState = {
        state: CircuitBreakerState.HALF_OPEN,
        consecutiveFailures: existing.consecutiveFailures,
        openedAt: existing.openedAt,
        halfOpenProbeInFlight: false,
      };
      this.states.set(providerId, recovered);
      return recovered;
    }

    this.states.set(providerId, existing);
    return existing;
  }
}
