import { EventEmitter } from 'node:events';

import type { AuthMode, StoredZkLoginSession } from '@hivemind-os/collective-core';

export type DaemonAuthState = 'authenticated' | 'expiring' | 'expired' | 'reauth_required';

export interface DaemonAuthStatus {
  authMode: AuthMode;
  authenticated: boolean;
  state: DaemonAuthState;
  address: string | null;
  expiresAt: number | null;
  expiresInMs: number | null;
  refreshAvailable: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface SessionMonitorAuthProvider {
  mode: 'zklogin';
  isAuthenticated(): boolean;
  getSession(): StoredZkLoginSession | null;
  getSessionExpiryMs(session?: StoredZkLoginSession | null): number | null;
  refreshSessionIfNeeded(
    currentEpoch?: number,
    options?: { force?: boolean; invalidateOnFailure?: boolean; throwOnFailure?: boolean },
  ): Promise<StoredZkLoginSession | null>;
  clearSession(session?: StoredZkLoginSession | null): Promise<void>;
}

export interface SessionMonitorOptions {
  authProvider: SessionMonitorAuthProvider;
  checkIntervalMs?: number;
  warningWindowMs?: number;
  logger?: {
    debug?: (payload: unknown, message?: string) => void;
    info?: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
}

type SessionMonitorEvents = {
  'session:expiring': [DaemonAuthStatus];
  'session:expired': [DaemonAuthStatus];
  'session:refreshed': [DaemonAuthStatus];
  'session:reauth_required': [DaemonAuthStatus];
};

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_WARNING_WINDOW_MS = 5 * 60 * 1000;

export class SessionMonitor extends EventEmitter {
  private readonly checkIntervalMs: number;
  private readonly warningWindowMs: number;
  private readonly logger;
  private interval?: ReturnType<typeof setInterval>;
  private checkInFlight?: Promise<DaemonAuthStatus>;
  private status: DaemonAuthStatus;

  constructor(private readonly options: SessionMonitorOptions) {
    super();
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.warningWindowMs = options.warningWindowMs ?? DEFAULT_WARNING_WINDOW_MS;
    this.logger = options.logger;
    this.status = this.createStatus(null, 'reauth_required');
  }

  override on<EventName extends keyof SessionMonitorEvents>(
    eventName: EventName,
    listener: (...args: SessionMonitorEvents[EventName]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override emit<EventName extends keyof SessionMonitorEvents>(eventName: EventName, ...args: SessionMonitorEvents[EventName]): boolean {
    return super.emit(eventName, ...args);
  }

  start(): void {
    if (this.interval) {
      return;
    }

    void this.checkNow();
    this.interval = setInterval(() => {
      void this.checkNow();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = undefined;
  }

  getStatus(): DaemonAuthStatus {
    return { ...this.status };
  }

  async checkNow(): Promise<DaemonAuthStatus> {
    if (this.checkInFlight) {
      return await this.checkInFlight;
    }

    this.checkInFlight = this.evaluate().finally(() => {
      this.checkInFlight = undefined;
    });
    return await this.checkInFlight;
  }

  private async evaluate(): Promise<DaemonAuthStatus> {
    const previous = this.status;
    const session = this.options.authProvider.getSession();
    if (!session || !this.options.authProvider.isAuthenticated()) {
      const status = this.updateStatus(this.createStatus(session, 'reauth_required'));
      if (previous.state !== status.state || previous.address !== status.address) {
        this.emit('session:reauth_required', { ...status });
      }
      return status;
    }

    const expiresAt = this.options.authProvider.getSessionExpiryMs(session);
    const now = Date.now();
    const expiresInMs = expiresAt === null ? null : expiresAt - now;

    if (expiresInMs !== null && expiresInMs <= 0) {
      const expiredStatus = this.updateStatus(this.createStatus(session, 'expired', null, expiresAt, expiresInMs));
      if (previous.state !== expiredStatus.state || previous.expiresAt !== expiredStatus.expiresAt) {
        this.emit('session:expired', { ...expiredStatus });
      }
      await this.options.authProvider.clearSession(session);
      const reauthStatus = this.updateStatus(
        this.createStatus(null, 'reauth_required', 'Authentication expired. Please re-authenticate via the daemon portal.'),
      );
      this.emit('session:reauth_required', { ...reauthStatus });
      this.logger?.warn?.({ expiresAt }, 'zkLogin session expired.');
      return reauthStatus;
    }

    if (expiresInMs !== null && expiresInMs <= this.warningWindowMs) {
      const expiringStatus = this.updateStatus(this.createStatus(session, 'expiring', null, expiresAt, expiresInMs));
      if (previous.state !== expiringStatus.state || previous.expiresAt !== expiringStatus.expiresAt) {
        this.emit('session:expiring', { ...expiringStatus });
      }

      try {
        const refreshed = await this.options.authProvider.refreshSessionIfNeeded(undefined, {
          force: true,
          invalidateOnFailure: true,
          throwOnFailure: true,
        });
        if (!refreshed) {
          const reauthStatus = this.updateStatus(
            this.createStatus(null, 'reauth_required', 'Authentication expired. Please re-authenticate via the daemon portal.'),
          );
          this.emit('session:reauth_required', { ...reauthStatus });
          return reauthStatus;
        }

        const refreshedStatus = this.updateStatus(this.createStatus(refreshed, 'authenticated'));
        this.emit('session:refreshed', { ...refreshedStatus });
        this.logger?.info?.({ expiresAt: refreshedStatus.expiresAt }, 'zkLogin session refreshed.');
        return refreshedStatus;
      } catch (error) {
        const detail = error instanceof Error && error.message ? error.message : 'Authentication expired. Please re-authenticate via the daemon portal.';
        const reauthStatus = this.updateStatus(this.createStatus(null, 'reauth_required', detail));
        this.emit('session:reauth_required', { ...reauthStatus });
        this.logger?.warn?.({ err: error }, 'zkLogin session refresh failed.');
        return reauthStatus;
      }
    }

    const refreshed = await this.options.authProvider.refreshSessionIfNeeded();
    if (!refreshed) {
      const reauthStatus = this.updateStatus(
        this.createStatus(null, 'reauth_required', 'Authentication expired. Please re-authenticate via the daemon portal.'),
      );
      if (previous.state !== reauthStatus.state || previous.address !== reauthStatus.address) {
        this.emit('session:reauth_required', { ...reauthStatus });
      }
      return reauthStatus;
    }

    if (refreshed.jwt !== session.jwt || refreshed.updatedAt !== session.updatedAt) {
      const refreshedStatus = this.updateStatus(this.createStatus(refreshed, 'authenticated'));
      this.emit('session:refreshed', { ...refreshedStatus });
      return refreshedStatus;
    }

    return this.updateStatus(this.createStatus(refreshed, 'authenticated'));
  }

  private createStatus(
    session: StoredZkLoginSession | null,
    state: DaemonAuthState,
    lastError: string | null = null,
    expiresAt = session ? this.options.authProvider.getSessionExpiryMs(session) : null,
    expiresInMs = expiresAt === null ? null : expiresAt - Date.now(),
  ): DaemonAuthStatus {
    return {
      authMode: this.options.authProvider.mode,
      authenticated: state === 'authenticated' || state === 'expiring',
      state,
      address: session?.address ?? null,
      expiresAt,
      expiresInMs,
      refreshAvailable: Boolean(session?.refreshToken),
      lastError,
      updatedAt: Date.now(),
    };
  }

  private updateStatus(nextStatus: DaemonAuthStatus): DaemonAuthStatus {
    this.status = nextStatus;
    return nextStatus;
  }
}
