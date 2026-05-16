import type { StoredZkLoginSession } from './types.js';

export enum SessionState {
  VALID = 'valid',
  REFRESHING = 'refreshing',
  NEEDS_REAUTH = 'needs_reauth',
  EXPIRED = 'expired',
}

export interface SessionRefreshPolicy {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  maxConsecutiveFailures?: number;
}

export interface SessionStateChangeEvent {
  previousState: SessionState;
  currentState: SessionState;
  session: StoredZkLoginSession | null;
  reason?: string;
  refreshFailureCount: number;
  error?: unknown;
}

export type SessionStateChangeCallback = (event: SessionStateChangeEvent) => void;
