import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import pino from 'pino';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { SessionExpiredError, SessionRefreshError } from './errors.js';
import {
  SessionState,
  type SessionRefreshPolicy,
  type SessionStateChangeCallback,
} from './session-state.js';
import type { OAuthProvider, StoredZkLoginSession } from './types.js';

interface SessionEnvelopeV1 {
  version: 1;
  metadata: {
    address: string;
    iss: string;
    sub: string;
    maxEpoch: number;
    updatedAt: number;
  };
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SessionEnvelopeV2 {
  version: 2;
  metadata: {
    maxEpoch: number;
    updatedAt: number;
  };
  iv: string;
  tag: string;
  ciphertext: string;
}

type SessionEnvelope = SessionEnvelopeV1 | SessionEnvelopeV2;

type SessionStoreLogger = Pick<ReturnType<typeof pino>, 'info' | 'warn' | 'error' | 'debug'>;

type SerializedSession = Omit<StoredZkLoginSession, 'ephemeralKeypair' | 'provider'> & {
  provider?: OAuthProvider;
  ephemeralSecretKey: string;
};

export interface ZkLoginSessionStoreOptions {
  refresh?: SessionRefreshPolicy;
  logger?: SessionStoreLogger;
  onSessionStateChange?: SessionStateChangeCallback;
  sleep?: (ms: number) => Promise<void>;
}

const SESSION_ENCRYPTION_INFO = Buffer.from('agentic-mesh:zklogin-session-store:v2', 'utf8');
const SESSION_ENCRYPTION_SALT = Buffer.from('aes-256-gcm', 'utf8');
// These defaults are intentionally overridable via ZkLoginSessionStoreOptions.refresh.
const DEFAULT_REFRESH_POLICY: Required<SessionRefreshPolicy> = {
  maxAttempts: 3,
  backoffMs: [1_000, 2_000, 4_000],
  maxConsecutiveFailures: 3,
};
const logger = pino({ name: '@hivemind-os/collective-core:auth:session-store' });

export class ZkLoginSessionStore {
  private readonly encryptionKey: Buffer;
  private readonly legacyEncryptionKey: Buffer;
  private readonly refreshPolicy: Required<SessionRefreshPolicy>;
  private readonly logger: SessionStoreLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stateChangeListeners = new Set<SessionStateChangeCallback>();

  private sessionState = SessionState.EXPIRED;
  private refreshFailureCount = 0;

  constructor(
    private readonly baseDir: string,
    encryptionKey: Uint8Array,
    options: ZkLoginSessionStoreOptions = {},
  ) {
    const keyMaterial = Buffer.from(encryptionKey);
    this.legacyEncryptionKey = Buffer.from(createHash('sha256').update(keyMaterial).digest());
    this.encryptionKey = Buffer.from(hkdfSync('sha256', keyMaterial, SESSION_ENCRYPTION_SALT, SESSION_ENCRYPTION_INFO, 32));
    this.refreshPolicy = {
      maxAttempts: options.refresh?.maxAttempts ?? DEFAULT_REFRESH_POLICY.maxAttempts,
      backoffMs: [...(options.refresh?.backoffMs ?? DEFAULT_REFRESH_POLICY.backoffMs)],
      maxConsecutiveFailures: options.refresh?.maxConsecutiveFailures ?? DEFAULT_REFRESH_POLICY.maxConsecutiveFailures,
    };
    this.logger = options.logger ?? logger;
    this.sleep = options.sleep ?? wait;
    if (options.onSessionStateChange) {
      this.stateChangeListeners.add(options.onSessionStateChange);
    }
  }

  getSessionState(): SessionState {
    return this.sessionState;
  }

  getRefreshFailureCount(): number {
    return this.refreshFailureCount;
  }

  onSessionStateChange(callback: SessionStateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);
    return () => {
      this.stateChangeListeners.delete(callback);
    };
  }

  async save(session: StoredZkLoginSession): Promise<void> {
    await this.ensureBaseDir();

    const normalizedSession = this.normalizeSession(session);
    const payload = this.serializeSession(normalizedSession);
    const envelope = this.encrypt(payload);
    const path = join(this.baseDir, getSessionFilename(normalizedSession));

    await writeFile(path, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
    this.updateSessionState(this.resolveSessionState(normalizedSession), normalizedSession, 'session_saved');
  }

  async loadLatest(): Promise<StoredZkLoginSession | null> {
    const sessions = await this.loadAll();
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions[0] ?? null;
  }

  async loadAll(): Promise<StoredZkLoginSession[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => {
            const path = join(this.baseDir, entry.name);
            try {
              return await this.readSessionFile(path);
            } catch (error) {
              if (isErrnoException(error, 'ENOENT')) {
                this.logger.debug({ path }, 'Session file removed before read, skipping.');
                return null;
              }
              if (isErrnoException(error)) {
                this.logger.error({ err: error, path }, 'Failed to read zkLogin session file.');
                throw error;
              }

              this.logger.warn({ err: error, path }, 'Skipping corrupted zkLogin session file.');
              return null;
            }
          }),
      );

      return sessions.filter((session): session is StoredZkLoginSession => session !== null);
    } catch (error) {
      if (isErrnoException(error, 'ENOENT')) {
        return [];
      }

      throw error;
    }
  }

  async loadLatestValid(currentEpoch: number): Promise<StoredZkLoginSession | null> {
    const latest = await this.loadLatest();
    if (!latest) {
      this.updateSessionState(SessionState.EXPIRED, null, 'session_missing');
      return null;
    }

    const sessionState = this.resolveSessionState(latest, currentEpoch);
    if (sessionState !== SessionState.VALID) {
      this.updateSessionState(sessionState, sessionState === SessionState.EXPIRED ? null : latest, 'session_invalid');
      return null;
    }

    this.updateSessionState(SessionState.VALID, latest, 'session_loaded');
    return latest;
  }

  async hasValidSession(currentEpoch: number): Promise<boolean> {
    return (await this.loadLatestValid(currentEpoch)) !== null;
  }

  isExpired(session: Pick<StoredZkLoginSession, 'maxEpoch'>, currentEpoch: number): boolean {
    return currentEpoch >= session.maxEpoch;
  }

  isNearExpiry(
    session: Pick<StoredZkLoginSession, 'maxEpoch'>,
    currentEpoch: number,
    remainingEpochs = 1,
  ): boolean {
    return currentEpoch + remainingEpochs >= session.maxEpoch;
  }

  async refreshIfNeeded(
    currentEpoch: number,
    refresher: (session: StoredZkLoginSession) => Promise<StoredZkLoginSession | null>,
    options: { force?: boolean } = {},
  ): Promise<StoredZkLoginSession | null> {
    const session = await this.loadLatest();
    if (!session) {
      this.updateSessionState(SessionState.EXPIRED, null, 'session_missing');
      return null;
    }

    const currentState = this.resolveSessionState(session, currentEpoch);
    if (currentState === SessionState.EXPIRED) {
      this.updateSessionState(SessionState.EXPIRED, null, 'session_expired');
      return null;
    }

    if (currentState === SessionState.NEEDS_REAUTH) {
      this.updateSessionState(SessionState.NEEDS_REAUTH, session, 'session_needs_reauth');
      throw new SessionExpiredError('Stored zkLogin session requires re-authentication.', {
        consecutiveFailures: session.refreshFailureCount ?? 0,
        session,
        sessionState: SessionState.NEEDS_REAUTH,
      });
    }

    this.updateSessionState(SessionState.VALID, session, 'session_available');
    if ((!options.force && !this.isNearExpiry(session, currentEpoch)) || !session.refreshToken) {
      return session;
    }

    this.updateSessionState(SessionState.REFRESHING, session, 'refresh_started');

    let lastError: SessionRefreshError | null = null;
    for (let attempt = 1; attempt <= this.refreshPolicy.maxAttempts; attempt += 1) {
      this.logger.info(
        {
          address: session.address,
          attempt,
          currentEpoch,
          maxAttempts: this.refreshPolicy.maxAttempts,
          maxEpoch: session.maxEpoch,
          refreshFailureCount: session.refreshFailureCount ?? 0,
        },
        'Refreshing zkLogin session.',
      );

      try {
        const refreshed = await refresher(session);
        if (!refreshed) {
          throw new Error('zkLogin refresher returned no session.');
        }

        const normalizedSession = this.normalizeSession({
          ...refreshed,
          refreshFailureCount: 0,
          sessionState: SessionState.VALID,
        });
        await this.save(normalizedSession);
        this.logger.info(
          {
            address: normalizedSession.address,
            currentEpoch,
            maxEpoch: normalizedSession.maxEpoch,
          },
          'Refreshed zkLogin session.',
        );
        return normalizedSession;
      } catch (error) {
        const consecutiveFailures = (session.refreshFailureCount ?? 0) + attempt;
        lastError = new SessionRefreshError('Failed to refresh zkLogin session.', {
          attempts: attempt,
          maxAttempts: this.refreshPolicy.maxAttempts,
          retryDelaysMs: this.refreshPolicy.backoffMs,
          consecutiveFailures,
          sessionState: SessionState.REFRESHING,
          session,
          cause: error,
        });

        this.logger.warn(
          {
            address: session.address,
            attempt,
            currentEpoch,
            err: error,
            maxAttempts: this.refreshPolicy.maxAttempts,
            maxEpoch: session.maxEpoch,
            consecutiveFailures,
          },
          'zkLogin session refresh attempt failed.',
        );

        if (attempt < this.refreshPolicy.maxAttempts) {
          await this.sleep(this.refreshPolicy.backoffMs[Math.min(attempt - 1, this.refreshPolicy.backoffMs.length - 1)]);
        }
      }
    }

    const consecutiveFailures = (session.refreshFailureCount ?? 0) + this.refreshPolicy.maxAttempts;
    const nextState =
      consecutiveFailures >= this.refreshPolicy.maxConsecutiveFailures ? SessionState.NEEDS_REAUTH : SessionState.VALID;
    const failedSession = this.normalizeSession({
      ...session,
      refreshFailureCount: consecutiveFailures,
      sessionState: nextState,
      updatedAt: Date.now(),
    });
    await this.save(failedSession);

    if (nextState === SessionState.NEEDS_REAUTH) {
      this.logger.error(
        {
          address: failedSession.address,
          currentEpoch,
          maxConsecutiveFailures: this.refreshPolicy.maxConsecutiveFailures,
          maxEpoch: failedSession.maxEpoch,
          refreshFailureCount: consecutiveFailures,
        },
        'zkLogin session refresh failed and re-authentication is required.',
      );
      throw new SessionExpiredError('zkLogin session refresh failed. Re-authentication is required.', {
        attempts: this.refreshPolicy.maxAttempts,
        maxAttempts: this.refreshPolicy.maxAttempts,
        retryDelaysMs: this.refreshPolicy.backoffMs,
        consecutiveFailures,
        session: failedSession,
        sessionState: nextState,
        cause: lastError,
      });
    }

    throw new SessionRefreshError('zkLogin session refresh failed after retries.', {
      attempts: this.refreshPolicy.maxAttempts,
      maxAttempts: this.refreshPolicy.maxAttempts,
      retryDelaysMs: this.refreshPolicy.backoffMs,
      consecutiveFailures,
      sessionState: nextState,
      session: failedSession,
      cause: lastError,
    });
  }

  async delete(session: Pick<StoredZkLoginSession, 'iss' | 'sub'>): Promise<void> {
    await rm(join(this.baseDir, getSessionFilename(session)), { force: true });
  }

  async deleteExpired(currentEpoch: number): Promise<void> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => {
            const path = join(this.baseDir, entry.name);
            let session: StoredZkLoginSession;
            try {
              session = await this.readSessionFile(path);
            } catch (error) {
              if (isErrnoException(error, 'ENOENT')) {
                this.logger.debug({ path }, 'Session file removed before expiration check, skipping.');
                return;
              }
              if (isErrnoException(error)) {
                this.logger.error({ err: error, path }, 'Failed to inspect zkLogin session file for expiration.');
                throw error;
              }

              this.logger.warn({ err: error, path }, 'Skipping corrupted zkLogin session file during expiration cleanup.');
              return;
            }

            if (this.isExpired(session, currentEpoch)) {
              await rm(path, { force: true });
            }
          }),
      );
    } catch (error) {
      if (!isErrnoException(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  private serializeSession(session: StoredZkLoginSession): SerializedSession {
    const normalizedSession = this.normalizeSession(session);
    return {
      ...normalizedSession,
      ephemeralSecretKey: normalizedSession.ephemeralKeypair.getSecretKey(),
    };
  }

  private deserializeSession(session: SerializedSession): StoredZkLoginSession {
    return this.normalizeSession({
      ...session,
      provider: session.provider ?? inferOAuthProvider(session.iss),
      ephemeralKeypair: Ed25519Keypair.fromSecretKey(session.ephemeralSecretKey),
    });
  }

  private normalizeSession(session: StoredZkLoginSession): StoredZkLoginSession {
    return {
      ...session,
      refreshFailureCount: session.refreshFailureCount ?? 0,
      sessionState: normalizePersistedSessionState(session.sessionState),
    };
  }

  private resolveSessionState(session: StoredZkLoginSession, currentEpoch?: number): SessionState {
    if (typeof currentEpoch === 'number' && this.isExpired(session, currentEpoch)) {
      return SessionState.EXPIRED;
    }

    return session.sessionState === SessionState.NEEDS_REAUTH ? SessionState.NEEDS_REAUTH : SessionState.VALID;
  }

  private updateSessionState(
    nextState: SessionState,
    session: StoredZkLoginSession | null,
    reason?: string,
    error?: unknown,
  ): void {
    const previousState = this.sessionState;
    this.sessionState = nextState;
    this.refreshFailureCount = session?.refreshFailureCount ?? (nextState === SessionState.EXPIRED ? 0 : this.refreshFailureCount);
    if (previousState === nextState) {
      return;
    }

    for (const listener of this.stateChangeListeners) {
      listener({
        previousState,
        currentState: nextState,
        session,
        reason,
        refreshFailureCount: this.refreshFailureCount,
        error,
      });
    }
  }

  private encrypt(session: SerializedSession): SessionEnvelope {
    const metadata: SessionEnvelopeV2['metadata'] = {
      maxEpoch: session.maxEpoch,
      updatedAt: session.updatedAt,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 2,
      metadata,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(envelope: SessionEnvelope): StoredZkLoginSession {
    const version = (envelope as { version: number }).version;
    if (version === 1) {
      return this.decryptEnvelope(envelope, this.legacyEncryptionKey);
    }

    if (version !== 2) {
      throw new Error(`Unsupported zkLogin session version: ${String(version)}`);
    }

    return this.decryptEnvelope(envelope, this.encryptionKey, envelope.metadata);
  }

  private decryptEnvelope(
    envelope: SessionEnvelope,
    encryptionKey: Buffer,
    metadata?: SessionEnvelopeV2['metadata'],
  ): StoredZkLoginSession {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.iv, 'base64'));
    if (metadata) {
      decipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return this.deserializeSession(JSON.parse(plaintext) as SerializedSession);
  }

  private async readSessionFile(path: string): Promise<StoredZkLoginSession> {
    const contents = await readFile(path, 'utf8');
    return this.decrypt(JSON.parse(contents) as SessionEnvelope);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await chmod(this.baseDir, 0o700);
  }
}

function getSessionFilename(session: Pick<StoredZkLoginSession, 'iss' | 'sub'>): string {
  const digest = createHash('sha256')
    .update(`${session.iss}:${session.sub}`)
    .digest('hex');
  return `${digest}.json`;
}

function inferOAuthProvider(issuer: string): OAuthProvider {
  if (issuer === 'https://accounts.google.com') {
    return 'google';
  }

  if (issuer === 'https://appleid.apple.com') {
    return 'apple';
  }

  throw new Error(`Unsupported zkLogin issuer: ${issuer}`);
}

function normalizePersistedSessionState(sessionState?: SessionState): SessionState {
  return sessionState === SessionState.NEEDS_REAUTH ? SessionState.NEEDS_REAUTH : SessionState.VALID;
}

function isErrnoException(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (code === undefined || error.code === code);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
