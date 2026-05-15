export interface HealthMonitorStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  connectedProviders: number;
  activeRequests: number;
  totalRequestsServed: number;
  averageLatencyMs: number;
}

export interface HealthMonitorOptions {
  now?: () => number;
  getConnectedProviders?: () => number;
}

export class HealthMonitor {
  private readonly now: () => number;
  private readonly startedAt: number;
  private activeRequests = 0;
  private connectedProviders = 0;
  private totalRequestsServed = 0;
  private totalLatencyMs = 0;

  constructor(private readonly options: HealthMonitorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  setConnectedProviders(count: number): void {
    this.connectedProviders = count;
  }

  beginRequest(): { finish: () => void } {
    const startedAt = this.now();
    let finished = false;
    this.activeRequests += 1;

    return {
      finish: () => {
        if (finished) {
          return;
        }

        finished = true;
        this.activeRequests -= 1;
        this.totalRequestsServed += 1;
        this.totalLatencyMs += this.now() - startedAt;
      },
    };
  }

  recordRequest(latencyMs: number): void {
    this.totalRequestsServed += 1;
    this.totalLatencyMs += latencyMs;
  }

  getStatus(): HealthMonitorStatus {
    const connectedProviders = this.options.getConnectedProviders?.() ?? this.connectedProviders;
    let status: HealthMonitorStatus['status'] = 'healthy';

    if (connectedProviders === 0 && this.activeRequests > 0) {
      status = 'unhealthy';
    } else if (connectedProviders === 0) {
      status = 'degraded';
    }

    return {
      status,
      uptime: this.now() - this.startedAt,
      connectedProviders,
      activeRequests: this.activeRequests,
      totalRequestsServed: this.totalRequestsServed,
      averageLatencyMs:
        this.totalRequestsServed === 0 ? 0 : Math.round(this.totalLatencyMs / this.totalRequestsServed),
    };
  }
}
