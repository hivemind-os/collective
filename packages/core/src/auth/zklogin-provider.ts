import { createHash, randomBytes } from 'node:crypto';

import { type PublicKey, Signer, type SignatureScheme } from '@mysten/sui/cryptography';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  decodeJwt,
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
  toZkLoginPublicIdentifier,
  type ZkLoginPublicIdentifier,
} from '@mysten/sui/zklogin';

import { SessionExpiredError, SessionRefreshError } from './errors.js';
import { ZkLoginSessionStore } from './session-store.js';
import { SessionState, type SessionStateChangeCallback } from './session-state.js';
import type {
  AuthProvider,
  OAuthConfig,
  OAuthProvider,
  OAuthTokenResponse,
  StoredZkLoginSession,
  ZkLoginProof,
} from './types.js';

const encoder = new TextEncoder();
const DEFAULT_SCOPES: Record<OAuthProvider, string[]> = {
  google: ['openid', 'email'],
  apple: ['name', 'email'],
};
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_WARNING_MS = 5 * 60 * 1000;
const DEFAULT_ENDPOINTS = {
  google: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    saltEndpoint: 'https://salt.api.mystenlabs.com/get_salt',
    proverEndpoint: 'https://prover.mystenlabs.com/v1',
    issuer: 'https://accounts.google.com',
  },
  apple: {
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    saltEndpoint: 'https://salt.api.mystenlabs.com/get_salt',
    proverEndpoint: 'https://prover.mystenlabs.com/v1',
    issuer: 'https://appleid.apple.com',
  },
} as const;

export interface ZkLoginPendingSession {
  epoch: number;
  maxEpoch: number;
  randomness: string;
  nonce: string;
  ephemeralKeypair: Ed25519Keypair;
}

export interface ZkLoginAuthorizationRequest {
  authorizationUrl: string;
  pendingSession: ZkLoginPendingSession;
}

export interface ZkLoginProviderOptions {
  client: Pick<SuiClient, 'getCurrentEpoch'>;
  oauth: OAuthConfig;
  sessionStore?: ZkLoginSessionStore;
  fetchFn?: typeof fetch;
}

export interface RefreshSessionOptions {
  force?: boolean;
  invalidateOnFailure?: boolean;
  throwOnFailure?: boolean;
  now?: number;
}

export class ZkLoginProvider implements AuthProvider {
  readonly mode = 'zklogin' as const;

  private session: StoredZkLoginSession | null = null;
  private sessionState = SessionState.EXPIRED;
  private readonly signer = new ZkLoginSuiSigner(() => this.requireSession(), () => this.getPublicIdentifier());
  private readonly fetchFn: typeof fetch;
  private readonly sessionStateListeners = new Set<SessionStateChangeCallback>();
  private oauth: OAuthConfig;

  constructor(private readonly options: ZkLoginProviderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.oauth = options.oauth;
    this.options.sessionStore?.onSessionStateChange((event) => {
      this.updateSessionState(event.currentState, event.session, event.reason, event.error);
    });
  }

  getOAuthConfig(): OAuthConfig {
    return { ...this.oauth };
  }

  setOAuthConfig(oauth: OAuthConfig): void {
    this.oauth = oauth;
  }

  async restoreSession(): Promise<boolean> {
    const currentEpoch = await this.getCurrentEpoch();
    await this.options.sessionStore?.deleteExpired(currentEpoch);

    try {
      const refreshed = await this.refreshSessionIfNeeded(currentEpoch);
      if (refreshed) {
        this.session = refreshed;
        this.updateSessionState(SessionState.VALID, refreshed, 'session_restored');
        return true;
      }
    } catch (error) {
      this.session = null;
      if (error instanceof SessionExpiredError) {
        this.updateSessionState(error.sessionState, null, 'session_restore_failed', error);
      }
      throw error;
    }

    const loadedSession = (await this.options.sessionStore?.loadLatestValid(currentEpoch)) ?? null;
    if (loadedSession && isSessionTokenExpired(loadedSession, Date.now())) {
      await this.clearSession(loadedSession);
      return false;
    }

    this.session = loadedSession;
    this.updateSessionState(loadedSession ? SessionState.VALID : SessionState.EXPIRED, loadedSession, 'session_restored');
    return this.session !== null;
  }

  async createAuthorizationRequest(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes?: string[];
  }): Promise<ZkLoginAuthorizationRequest> {
    const pendingSession = await this.createPendingSession();
    const authorizationUrl = this.buildAuthorizationUrl({
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      nonce: pendingSession.nonce,
      scopes: params.scopes,
    });

    return {
      authorizationUrl,
      pendingSession,
    };
  }

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const response = await this.fetchJson(
      this.getTokenEndpoint(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: this.oauth.clientId,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }).toString(),
      },
      'token',
    );

    return normalizeTokenResponse(response);
  }

  async refreshSessionIfNeeded(
    currentEpoch?: number,
    options: RefreshSessionOptions = {},
  ): Promise<StoredZkLoginSession | null> {
    const epoch = currentEpoch ?? (await this.getCurrentEpoch());
    const current = await this.loadCurrentSession(epoch);
    if (!current) {
      this.session = null;
      this.updateSessionState(this.options.sessionStore?.getSessionState() ?? SessionState.EXPIRED, null, 'session_missing');
      return null;
    }

    const now = options.now ?? Date.now();
    const tokenExpired = isSessionTokenExpired(current, now);
    const tokenExpiring = isSessionTokenExpiring(current, now);
    const requiresRefresh = options.force || tokenExpired || tokenExpiring || this.options.sessionStore?.isNearExpiry(current, epoch) === true;

    if (!requiresRefresh) {
      this.session = current;
      this.updateSessionState(SessionState.VALID, current, 'session_available');
      return current;
    }

    if (!current.refreshToken) {
      return await this.handleRefreshFailure(current, options, undefined, tokenExpired);
    }

    if (!this.options.sessionStore) {
      try {
        const pendingSession = await this.createPendingSession();
        const tokens = await this.refreshTokens(current.refreshToken, pendingSession.nonce);
        return await this.authenticateWithJwt(tokens.jwt, {
          pendingSession,
          refreshToken: tokens.refreshToken ?? current.refreshToken,
          validateNonce: false,
        });
      } catch (error) {
        return await this.handleRefreshFailure(current, options, error, tokenExpired);
      }
    }

    try {
      const refreshed = await this.options.sessionStore.refreshIfNeeded(
        epoch,
        async (storedSession) => {
          const pendingSession = await this.createPendingSession();
          const tokens = await this.refreshTokens(storedSession.refreshToken ?? current.refreshToken ?? '', pendingSession.nonce);
          return await this.authenticateWithJwt(tokens.jwt, {
            pendingSession,
            refreshToken: tokens.refreshToken ?? storedSession.refreshToken,
            validateNonce: false,
          });
        },
        { force: true },
      );
      this.session = refreshed;
      this.updateSessionState(refreshed ? SessionState.VALID : SessionState.EXPIRED, refreshed, 'session_refreshed');
      return refreshed;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        this.session = null;
        this.updateSessionState(error.sessionState, null, 'session_refresh_failed', error);
        throw error;
      }

      if (error instanceof SessionRefreshError && (options.throwOnFailure || tokenExpired || options.force)) {
        this.session = null;
        this.updateSessionState(SessionState.NEEDS_REAUTH, null, 'session_refresh_failed', error);
        throw new SessionExpiredError('zkLogin session refresh failed. Re-authentication is required.', {
          attempts: error.attempts,
          maxAttempts: error.maxAttempts,
          retryDelaysMs: error.retryDelaysMs,
          consecutiveFailures: error.consecutiveFailures,
          sessionState: SessionState.NEEDS_REAUTH,
          session: current,
          cause: error,
        });
      }

      throw error;
    }
  }

  async authenticateWithJwt(
    jwt: string,
    params: {
      pendingSession: ZkLoginPendingSession;
      refreshToken?: string;
      validateNonce?: boolean;
    },
  ): Promise<StoredZkLoginSession> {
    const decoded = validateJwtClaims(decodeJwt(jwt), {
      expectedIssuer: this.getIssuer(),
      expectedClientId: this.oauth.clientId,
      expectedNonce: params.validateNonce === false ? undefined : params.pendingSession.nonce,
    });
    const salt = await this.fetchSalt(jwt);
    const proof = await this.fetchProof(jwt, salt, params.pendingSession);
    const addressSeed = genAddressSeed(salt, 'sub', decoded.sub, decoded.aud).toString();
    const timestamp = Date.now();

    const session: StoredZkLoginSession = {
      provider: this.oauth.provider,
      jwt,
      salt,
      epoch: params.pendingSession.epoch,
      ephemeralKeypair: params.pendingSession.ephemeralKeypair,
      proof: {
        ...proof,
        addressSeed,
      },
      maxEpoch: params.pendingSession.maxEpoch,
      address: jwtToAddress(jwt, salt),
      sub: decoded.sub,
      iss: decoded.iss,
      aud: decoded.aud,
      randomness: params.pendingSession.randomness,
      refreshToken: params.refreshToken,
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionState: SessionState.VALID,
      refreshFailureCount: 0,
    };

    this.session = session;
    await this.options.sessionStore?.save(session);
    this.updateSessionState(SessionState.VALID, session, 'session_authenticated');
    return session;
  }

  async getAddress(): Promise<string> {
    return this.requireSession().address;
  }

  getDID(): string {
    const session = this.requireSession();
    return `did:mesh:zklogin:${session.address}`;
  }

  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.signer.signTransaction(tx);
    return encoder.encode(signature);
  }

  async signPersonalMessage(message: Uint8Array): Promise<{ signature: Uint8Array }> {
    const { signature } = await this.signer.signPersonalMessage(message);
    return { signature: encoder.encode(signature) };
  }

  isAuthenticated(): boolean {
    const session = this.session;
    if (!session) {
      return false;
    }

    if (this.sessionState === SessionState.NEEDS_REAUTH || this.sessionState === SessionState.EXPIRED) {
      return false;
    }

    if (isSessionTokenExpired(session, Date.now())) {
      this.dropSession(session);
      return false;
    }

    return true;
  }

  getPublicKey(): Uint8Array {
    return this.getPublicIdentifier().toRawBytes();
  }

  toSuiSigner(): Signer {
    return this.signer;
  }

  getSession(): StoredZkLoginSession | null {
    return this.session;
  }

  getSessionState(): SessionState {
    return this.options.sessionStore?.getSessionState() ?? this.sessionState;
  }

  onSessionStateChange(callback: SessionStateChangeCallback): () => void {
    this.sessionStateListeners.add(callback);
    return () => {
      this.sessionStateListeners.delete(callback);
    };
  }

  async isSessionValid(currentEpoch?: number): Promise<boolean> {
    const session = this.session;
    if (!session) {
      return false;
    }

    if (this.getSessionState() === SessionState.NEEDS_REAUTH || this.getSessionState() === SessionState.EXPIRED) {
      return false;
    }

    const epoch = currentEpoch ?? (await this.getCurrentEpoch());
    if ((this.options.sessionStore?.isExpired(session, epoch) ?? epoch >= session.maxEpoch) || isSessionTokenExpiring(session, Date.now())) {
      return false;
    }

    return !isSessionTokenExpired(session, Date.now());
  }

  getSessionExpiryMs(session = this.session): number | null {
    return getSessionExpiryMs(session);
  }

  async clearSession(session = this.session): Promise<void> {
    if (!session) {
      this.session = null;
      this.updateSessionState(SessionState.EXPIRED, null, 'session_cleared');
      return;
    }

    this.session = null;
    await this.options.sessionStore?.delete(session);
    this.updateSessionState(SessionState.EXPIRED, null, 'session_cleared');
  }

  private async refreshTokens(refreshToken: string, nonce: string): Promise<OAuthTokenResponse> {
    const response = await this.fetchJson(
      this.getTokenEndpoint(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.oauth.clientId,
          grant_type: 'refresh_token',
          nonce,
          refresh_token: refreshToken,
        }).toString(),
      },
      'token',
    );

    return normalizeTokenResponse(response);
  }

  private async createPendingSession(): Promise<ZkLoginPendingSession> {
    const epoch = await this.getCurrentEpoch();
    const maxEpoch = epoch + 2;
    const ephemeralKeypair = Ed25519Keypair.generate();
    const randomness = generateRandomness();
    const nonce = generateNonce(ephemeralKeypair.getPublicKey(), maxEpoch, randomness);

    return {
      epoch,
      maxEpoch,
      randomness,
      nonce,
      ephemeralKeypair,
    };
  }

  private buildAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    nonce: string;
    scopes?: string[];
  }): string {
    const url = new URL(this.getAuthorizationEndpoint());
    url.searchParams.set('client_id', this.oauth.clientId);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', (params.scopes ?? this.oauth.scopes ?? DEFAULT_SCOPES[this.oauth.provider]).join(' '));
    url.searchParams.set('state', params.state);

    if (this.oauth.provider === 'apple') {
      url.searchParams.set('response_mode', 'form_post');
      url.searchParams.set('response_type', 'code id_token');
      return url.toString();
    }

    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    return url.toString();
  }

  private async fetchSalt(jwt: string): Promise<string> {
    const response = await this.fetchJson(
      this.getSaltEndpoint(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: jwt }),
      },
      'salt',
    );

    const nestedData = isRecord(response.data) ? response.data : undefined;
    const salt = readStringValue(response.salt) ?? readStringValue(nestedData?.salt);
    if (!salt) {
      throw new Error('zkLogin salt response did not contain a salt value.');
    }

    return salt;
  }

  private async fetchProof(
    jwt: string,
    salt: string,
    pendingSession: ZkLoginPendingSession,
  ): Promise<Omit<ZkLoginProof, 'addressSeed'>> {
    const response = await this.fetchJson(
      this.getProverEndpoint(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jwt,
          extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(pendingSession.ephemeralKeypair.getPublicKey()),
          maxEpoch: pendingSession.maxEpoch,
          jwtRandomness: pendingSession.randomness,
          salt,
          keyClaimName: 'sub',
        }),
      },
      'prover',
    );

    const payload = isRecord(response.data) ? response.data : response;
    if (!isZkLoginProofPayload(payload)) {
      throw new Error('zkLogin prover response was missing proof fields.');
    }

    return {
      proofPoints: payload.proofPoints,
      issBase64Details: payload.issBase64Details,
      headerBase64: payload.headerBase64,
    };
  }

  private async fetchJson(url: string, init: RequestInit, operation: 'token' | 'salt' | 'prover'): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      const body = text ? parseJsonObject(text, `OAuth ${operation} response`) : {};

      if (!response.ok) {
        const detail = readStringValue(body.error_description) ?? readStringValue(body.error) ?? response.statusText;
        throw new Error(`OAuth ${operation} request failed (${response.status}): ${detail}`);
      }

      return body;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error(`OAuth ${operation} request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`);
      }

      if (error instanceof Error && error.message.startsWith('OAuth ')) {
        throw error;
      }

      if (error instanceof Error) {
        throw new Error(`OAuth ${operation} request failed: ${error.message}`, { cause: error });
      }

      throw new Error(`OAuth ${operation} request failed.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private getPublicIdentifier(): ZkLoginPublicIdentifier {
    const session = this.requireSession();
    return toZkLoginPublicIdentifier(BigInt(session.proof.addressSeed), session.iss);
  }

  private requireSession(): StoredZkLoginSession {
    const session = this.session;
    if (!session) {
      throw new SessionExpiredError('Authentication expired. Please re-authenticate via the daemon portal.', {
        consecutiveFailures: this.options.sessionStore?.getRefreshFailureCount(),
        sessionState: this.getSessionState(),
      });
    }

    if (isSessionTokenExpired(session, Date.now())) {
      this.dropSession(session);
      throw new SessionExpiredError('Authentication expired. Please re-authenticate via the daemon portal.', {
        consecutiveFailures: this.options.sessionStore?.getRefreshFailureCount(),
        session,
        sessionState: SessionState.EXPIRED,
      });
    }

    return session;
  }

  private async loadCurrentSession(epoch: number): Promise<StoredZkLoginSession | null> {
    const inMemory = this.session;
    if (inMemory && (!this.options.sessionStore || !this.options.sessionStore.isExpired(inMemory, epoch))) {
      return inMemory;
    }

    if (!this.options.sessionStore) {
      return inMemory ?? null;
    }

    const session = await this.options.sessionStore.loadLatestValid(epoch);
    this.session = session;
    if (!session && this.options.sessionStore.getSessionState() === SessionState.NEEDS_REAUTH) {
      throw new SessionExpiredError('Authentication expired. Please re-authenticate via the daemon portal.', {
        consecutiveFailures: this.options.sessionStore.getRefreshFailureCount(),
        sessionState: SessionState.NEEDS_REAUTH,
      });
    }

    return session;
  }

  private async handleRefreshFailure(
    session: StoredZkLoginSession,
    options: RefreshSessionOptions,
    error?: unknown,
    tokenExpired = false,
  ): Promise<StoredZkLoginSession | null> {
    if (tokenExpired || options.invalidateOnFailure || options.throwOnFailure || options.force) {
      const nextState = tokenExpired ? SessionState.EXPIRED : SessionState.NEEDS_REAUTH;
      this.session = null;
      this.updateSessionState(nextState, null, 'session_refresh_failed', error);
      throw new SessionExpiredError('Authentication expired. Please re-authenticate via the daemon portal.', {
        consecutiveFailures: this.options.sessionStore?.getRefreshFailureCount(),
        session,
        sessionState: nextState,
        cause: error,
      });
    }

    this.session = session;
    this.updateSessionState(SessionState.VALID, session, 'session_available');
    return session;
  }

  private dropSession(session: StoredZkLoginSession): void {
    this.session = null;
    this.updateSessionState(SessionState.EXPIRED, null, 'session_expired');
    void this.options.sessionStore?.delete(session).catch(() => undefined);
  }

  private updateSessionState(
    nextState: SessionState,
    session: StoredZkLoginSession | null,
    reason?: string,
    error?: unknown,
  ): void {
    const previousState = this.sessionState;
    this.sessionState = nextState;
    if (previousState === nextState) {
      return;
    }

    for (const listener of this.sessionStateListeners) {
      listener({
        previousState,
        currentState: nextState,
        session,
        reason,
        refreshFailureCount: session?.refreshFailureCount ?? this.options.sessionStore?.getRefreshFailureCount() ?? 0,
        error,
      });
    }
  }

  private async getCurrentEpoch(): Promise<number> {
    const currentEpoch = await this.options.client.getCurrentEpoch();
    return Number.parseInt(currentEpoch.epoch, 10);
  }

  private getAuthorizationEndpoint(): string {
    return this.oauth.authorizationEndpoint ?? DEFAULT_ENDPOINTS[this.oauth.provider].authorizationEndpoint;
  }

  private getTokenEndpoint(): string {
    return this.oauth.tokenEndpoint ?? DEFAULT_ENDPOINTS[this.oauth.provider].tokenEndpoint;
  }

  private getSaltEndpoint(): string {
    return this.oauth.saltEndpoint ?? DEFAULT_ENDPOINTS[this.oauth.provider].saltEndpoint;
  }

  private getProverEndpoint(): string {
    return this.oauth.proverEndpoint ?? DEFAULT_ENDPOINTS[this.oauth.provider].proverEndpoint;
  }

  private getIssuer(): string {
    return this.oauth.issuer ?? DEFAULT_ENDPOINTS[this.oauth.provider].issuer;
  }
}

class ZkLoginSuiSigner extends Signer {
  constructor(
    private readonly getSession: () => StoredZkLoginSession,
    private readonly getPublicIdentifier: () => ZkLoginPublicIdentifier,
  ) {
    super();
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    return this.getSession().ephemeralKeypair.sign(bytes);
  }

  override async signTransaction(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const session = this.getSession();
    const { bytes: signedBytes, signature: userSignature } = await session.ephemeralKeypair.signTransaction(bytes);
    return {
      bytes: signedBytes,
      signature: getZkLoginSignature({
        inputs: {
          ...session.proof,
        },
        maxEpoch: session.maxEpoch,
        userSignature,
      }),
    };
  }

  override async signPersonalMessage(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const session = this.getSession();
    const { bytes: signedBytes, signature: userSignature } = await session.ephemeralKeypair.signPersonalMessage(bytes);
    return {
      bytes: signedBytes,
      signature: getZkLoginSignature({
        inputs: {
          ...session.proof,
        },
        maxEpoch: session.maxEpoch,
        userSignature,
      }),
    };
  }

  getKeyScheme(): SignatureScheme {
    return 'ZkLogin';
  }

  getPublicKey(): PublicKey {
    return this.getPublicIdentifier();
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(64));
  return {
    verifier,
    challenge: base64UrlEncode(createHash('sha256').update(verifier).digest()),
  };
}

function normalizeTokenResponse(value: Record<string, unknown>): OAuthTokenResponse {
  const jwt = readStringValue(value.id_token) ?? readStringValue(value.jwt);
  if (!jwt) {
    throw new Error('OAuth token response did not contain an id_token.');
  }

  return {
    jwt,
    refreshToken: readStringValue(value.refresh_token),
    accessToken: readStringValue(value.access_token),
    expiresIn:
      typeof value.expires_in === 'number'
        ? value.expires_in
        : typeof value.expires_in === 'string' && /^\d+$/.test(value.expires_in)
          ? Number(value.expires_in)
          : undefined,
    tokenType: readStringValue(value.token_type),
    scope: readStringValue(value.scope),
  };
}

function getSessionExpiryMs(session: Pick<StoredZkLoginSession, 'jwt'> | null | undefined): number | null {
  if (!session) {
    return null;
  }

  const exp = decodeJwt(session.jwt).exp;
  const expSeconds = typeof exp === 'number' ? exp : typeof exp === 'string' && /^\d+$/.test(exp) ? Number(exp) : null;
  return expSeconds === null ? null : expSeconds * 1_000;
}

function isSessionTokenExpired(session: Pick<StoredZkLoginSession, 'jwt'>, now: number): boolean {
  const expiresAt = getSessionExpiryMs(session);
  return expiresAt !== null && expiresAt <= now;
}

function isSessionTokenExpiring(
  session: Pick<StoredZkLoginSession, 'jwt'>,
  now: number,
  warningMs = TOKEN_EXPIRY_WARNING_MS,
): boolean {
  const expiresAt = getSessionExpiryMs(session);
  return expiresAt !== null && expiresAt - now <= warningMs;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRequiredStringValue(value: unknown, field: string): string {
  const parsed = readStringValue(value);
  if (!parsed) {
    throw new Error(`OAuth token did not contain a valid ${field} claim.`);
  }

  return parsed;
}

function validateJwtClaims(
  claims: Record<string, unknown>,
  params: { expectedIssuer: string; expectedClientId: string; expectedNonce?: string },
): { iss: string; sub: string; aud: string } {
  const iss = readRequiredStringValue(claims.iss, 'iss');
  if (iss !== params.expectedIssuer) {
    throw new Error(`OAuth token issuer mismatch. Expected ${params.expectedIssuer}.`);
  }

  const sub = readRequiredStringValue(claims.sub, 'sub');
  const audiences = normalizeAudiences(claims.aud);
  if (!audiences.includes(params.expectedClientId)) {
    throw new Error('OAuth token audience mismatch.');
  }

  if (params.expectedNonce !== undefined) {
    const nonce = readRequiredStringValue(claims.nonce, 'nonce');
    if (nonce !== params.expectedNonce) {
      throw new Error('OAuth token nonce mismatch.');
    }
  }

  return {
    iss,
    sub,
    aud: typeof claims.aud === 'string' ? claims.aud : params.expectedClientId,
  };
}

function normalizeAudiences(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }

  throw new Error('OAuth token did not contain a valid aud claim.');
}

function parseJsonObject(text: string, context: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} was not valid JSON.`, { cause: error as Error });
  }

  if (!isRecord(value)) {
    throw new Error(`${context} was not a JSON object.`);
  }

  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isZkLoginProofPayload(value: Record<string, unknown>): value is {
  proofPoints: ZkLoginProof['proofPoints'];
  issBase64Details: ZkLoginProof['issBase64Details'];
  headerBase64: string;
} {
  return (
    isRecord(value.proofPoints) &&
    isRecord(value.issBase64Details) &&
    typeof value.headerBase64 === 'string' &&
    Array.isArray((value.proofPoints as Record<string, unknown>).a) &&
    Array.isArray((value.proofPoints as Record<string, unknown>).b) &&
    Array.isArray((value.proofPoints as Record<string, unknown>).c) &&
    typeof (value.issBase64Details as Record<string, unknown>).value === 'string' &&
    typeof (value.issBase64Details as Record<string, unknown>).indexMod4 === 'number'
  );
}
