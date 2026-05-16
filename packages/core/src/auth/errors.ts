import { SessionState } from './session-state.js';
import type { StoredZkLoginSession } from './types.js';

interface SessionContext {
  address: string;
  iss: string;
  maxEpoch: number;
  updatedAt: number;
}

function toSessionContext(session?: StoredZkLoginSession | null): SessionContext | undefined {
  if (!session) {
    return undefined;
  }

  return {
    address: session.address,
    iss: session.iss,
    maxEpoch: session.maxEpoch,
    updatedAt: session.updatedAt,
  };
}

export interface SessionRefreshErrorOptions {
  attempts: number;
  maxAttempts: number;
  retryDelaysMs: readonly number[];
  consecutiveFailures: number;
  sessionState: SessionState;
  session?: StoredZkLoginSession | null;
  cause?: unknown;
}

export class SessionRefreshError extends Error {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly retryDelaysMs: readonly number[];
  readonly consecutiveFailures: number;
  readonly sessionState: SessionState;
  readonly session?: SessionContext;

  constructor(message: string, options: SessionRefreshErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'SessionRefreshError';
    this.attempts = options.attempts;
    this.maxAttempts = options.maxAttempts;
    this.retryDelaysMs = options.retryDelaysMs;
    this.consecutiveFailures = options.consecutiveFailures;
    this.sessionState = options.sessionState;
    this.session = toSessionContext(options.session);
  }
}

export interface SessionExpiredErrorOptions {
  attempts?: number;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  consecutiveFailures?: number;
  sessionState?: SessionState;
  session?: StoredZkLoginSession | null;
  cause?: unknown;
}

export class SessionExpiredError extends Error {
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly consecutiveFailures?: number;
  readonly sessionState: SessionState;
  readonly session?: SessionContext;

  constructor(message: string, options: SessionExpiredErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'SessionExpiredError';
    this.attempts = options.attempts;
    this.maxAttempts = options.maxAttempts;
    this.retryDelaysMs = options.retryDelaysMs;
    this.consecutiveFailures = options.consecutiveFailures;
    this.sessionState = options.sessionState ?? SessionState.NEEDS_REAUTH;
    this.session = toSessionContext(options.session);
  }
}
