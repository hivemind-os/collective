import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import type { AuthProvider, OAuthConfig, StoredZkLoginSession } from '@agentic-mesh/core';
import { createPkcePair, type ZkLoginPendingSession } from '@agentic-mesh/core';

import { saveConfig, type DaemonFullConfig } from '../config.js';
import type { DaemonAuthStatus } from '../auth/session-monitor.js';
import { buildOAuthConfig, type DaemonState } from '../state.js';

type PortalOAuthProvider = OAuthConfig['provider'];

type PortalAuthFlow = 'setup' | 'reauth';

interface PendingAuthState {
  provider: PortalOAuthProvider;
  flow: PortalAuthFlow;
  codeVerifier: string;
  pendingSession: ZkLoginPendingSession;
  createdAt: number;
}

export interface PortalAuthProvider extends AuthProvider {
  createAuthorizationRequest(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes?: string[];
  }): Promise<{
    authorizationUrl: string;
    pendingSession: ZkLoginPendingSession;
  }>;
  exchangeAuthorizationCode(code: string, codeVerifier: string, redirectUri: string): Promise<{
    jwt: string;
    refreshToken?: string;
  }>;
  authenticateWithJwt(
    jwt: string,
    params: { pendingSession: ZkLoginPendingSession; refreshToken?: string },
  ): Promise<StoredZkLoginSession>;
  getSession(): StoredZkLoginSession | null;
  getOAuthConfig(): OAuthConfig;
  setOAuthConfig(oauth: OAuthConfig): void;
}

export interface PortalLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface PortalServerOptions {
  config: DaemonFullConfig;
  configPath: string;
  authProvider: PortalAuthProvider;
  state?: DaemonState;
  logger?: PortalLogger;
  getAuthStatus?: () => DaemonAuthStatus | null;
  onAuthenticated?: (session: StoredZkLoginSession) => Promise<void> | void;
  onSettingsSaved?: (config: DaemonFullConfig) => Promise<void> | void;
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

type OAuthCallbackPayload = {
  code?: string;
  error?: string;
  error_description?: string;
  id_token?: string;
  state?: string;
  user?: string;
};

export class PortalServer {
  private readonly server: FastifyInstance;
  private readonly pendingAuth = new Map<string, PendingAuthState>();
  private baseUrl = '';
  private setupComplete = false;
  private completionPromise: Promise<void>;
  private resolveCompletion!: () => void;

  constructor(private readonly options: PortalServerOptions) {
    this.server = Fastify({ logger: false });
    this.setupComplete = Boolean(options.state);
    this.completionPromise = new Promise((resolvePromise) => {
      this.resolveCompletion = resolvePromise;
    });
  }

  async start(): Promise<string> {
    this.server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const payload = typeof body === 'string' ? body : body.toString('utf8');
      done(null, Object.fromEntries(new URLSearchParams(payload)));
    });

    await this.server.register(cors, {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        callback(null, isLoopbackOrigin(origin));
      },
    });
    this.registerRoutes();

    this.baseUrl = await this.server.listen({
      host: '127.0.0.1',
      port: this.options.config.auth.portal?.port ?? 19876,
    });
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    this.pendingAuth.clear();
    await this.server.close().catch(() => undefined);
  }

  async waitForAuth(): Promise<void> {
    if (this.setupComplete) {
      return;
    }

    await this.completionPromise;
  }

  getUrl(): string {
    return this.baseUrl;
  }

  getReauthUrl(): string {
    return `${this.baseUrl}/auth/reauth`;
  }

  private registerRoutes(): void {
    this.server.get('/', async (_request, reply) => {
      reply.type('text/html').send(this.renderPage());
    });

    this.server.get('/auth/reauth', async (_request, reply) => {
      reply.type('text/html').send(renderReauthPage(getConfiguredProviders(this.options.config)));
    });

    this.server.get('/auth/google', async (request, reply) => this.startAuthFlow('google', reply, readFlow(request.query)));
    this.server.get('/auth/apple', async (request, reply) => this.startAuthFlow('apple', reply, readFlow(request.query)));

    this.server.get('/auth/callback', async (request, reply) => {
      await this.handleOAuthCallback('google', request.query as OAuthCallbackPayload, reply);
    });

    this.server.post('/auth/apple/callback', async (request, reply) => {
      await this.handleOAuthCallback('apple', (request.body ?? {}) as OAuthCallbackPayload, reply);
    });

    this.server.get('/api/status', async () => {
      const auth = this.getAuthStatus();
      return {
        authenticated: auth.authenticated,
        authMode: auth.authMode,
        authState: auth.state,
        address: auth.address,
        auth,
        did: this.options.state?.did ?? null,
        setupComplete: this.setupComplete,
        spendingLimitMist: getCurrentDailyLimitMist(this.options.config).toString(),
      };
    });

    this.server.post('/api/settings', async (request, reply) => {
      const previousSettings = snapshotPortalSettings(this.options.config);

      try {
        const body = (request.body ?? {}) as {
          dailyLimitMist?: number | string;
          dailyLimitSui?: number | string;
        };
        const nextLimit = normalizeDailyLimit(body);
        updateDailyLimit(this.options.config, nextLimit);
        this.options.state?.spendingPolicy.updatePolicy(this.options.config.spending);
        await this.options.onSettingsSaved?.(this.options.config);
        await saveConfig(this.options.config, this.options.configPath);
        this.options.logger?.info({ configPath: this.options.configPath }, 'Portal settings persisted');
        this.setupComplete = true;
        this.resolveCompletion();

        return {
          ok: true,
          address: await this.options.authProvider.getAddress(),
          spendingLimitMist: nextLimit.toString(),
        };
      } catch (error) {
        restorePortalSettings(this.options.config, previousSettings);
        this.options.state?.spendingPolicy.updatePolicy(this.options.config.spending);
        if (!isInputValidationError(error)) {
          this.options.logger?.warn({ err: error, configPath: this.options.configPath }, 'Failed to persist portal settings');
        }

        return reply.code(isInputValidationError(error) ? 400 : 500).send({
          ok: false,
          error: getSafeErrorMessage(error, 'Unable to save settings.'),
        });
      }
    });
  }

  private async startAuthFlow(
    provider: PortalOAuthProvider,
    reply: FastifyReply,
    flow: PortalAuthFlow = 'setup',
  ): Promise<unknown> {
    if (!isProviderConfigured(this.options.config, provider)) {
      return reply.code(404).type('text/html').send(renderMessagePage('Authentication unavailable', `${capitalize(provider)} sign-in is not configured.`));
    }

    try {
      this.pruneExpiredPendingAuth();
      const state = randomBytes(16).toString('hex');
      const { verifier, challenge } = createPkcePair();
      this.setActiveOAuthConfig(provider);
      const authRequest = await this.options.authProvider.createAuthorizationRequest({
        redirectUri: this.getRedirectUri(provider),
        state,
        codeChallenge: challenge,
        scopes: provider === 'apple' ? ['name', 'email'] : undefined,
      });

      this.pendingAuth.set(state, {
        provider,
        flow,
        codeVerifier: verifier,
        pendingSession: authRequest.pendingSession,
        createdAt: Date.now(),
      });
      return reply.redirect(authRequest.authorizationUrl);
    } catch (error) {
      return reply
        .code(500)
        .type('text/html')
        .send(renderMessagePage('Authentication failed', getSafeErrorMessage(error, 'Unable to start sign-in.')));
    }
  }

  private async handleOAuthCallback(
    provider: PortalOAuthProvider,
    payload: OAuthCallbackPayload,
    reply: FastifyReply,
  ): Promise<void> {
    const code = readOptionalString(payload.code);
    const error = readOptionalString(payload.error);
    const errorDescription = readOptionalString(payload.error_description);
    const idToken = readOptionalString(payload.id_token);
    const state = readOptionalString(payload.state);

    this.pruneExpiredPendingAuth();

    if (error) {
      if (state) {
        this.pendingAuth.delete(state);
      }
      reply.code(400).type('text/html').send(renderMessagePage('Authentication failed', getOAuthErrorDetail(error, errorDescription)));
      return;
    }

    if (!state) {
      reply.code(400).type('text/html').send(renderMessagePage('Authentication failed', 'Missing callback state.'));
      return;
    }

    const pending = this.pendingAuth.get(state);
    if (!pending || pending.provider !== provider) {
      reply.code(400).type('text/html').send(renderMessagePage('Authentication failed', 'Unknown login state.'));
      return;
    }

    if (Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
      this.pendingAuth.delete(state);
      reply.code(400).type('text/html').send(renderMessagePage('Authentication failed', 'Login session expired. Please try again.'));
      return;
    }

    this.pendingAuth.delete(state);

    try {
      this.setActiveOAuthConfig(provider);
      const session = provider === 'apple'
        ? await this.authenticateAppleCallback(idToken, pending)
        : await this.authenticateGoogleCallback(code, pending);
      await this.options.onAuthenticated?.(session);

      reply.type('text/html').send(pending.flow === 'reauth' ? renderReauthCompletePage() : this.renderPage());
    } catch (callbackError) {
      reply
        .code(502)
        .type('text/html')
        .send(renderMessagePage('Authentication failed', getSafeErrorMessage(callbackError, 'Unable to complete sign-in.')));
    }
  }

  private async authenticateGoogleCallback(
    code: string | undefined,
    pending: PendingAuthState,
  ): Promise<StoredZkLoginSession> {
    if (!code) {
      throw new Error('Missing authorization code.');
    }

    const tokens = await this.options.authProvider.exchangeAuthorizationCode(
      code,
      pending.codeVerifier,
      this.getRedirectUri('google'),
    );
    return this.options.authProvider.authenticateWithJwt(tokens.jwt, {
      pendingSession: pending.pendingSession,
      refreshToken: tokens.refreshToken,
    });
  }

  private async authenticateAppleCallback(
    idToken: string | undefined,
    pending: PendingAuthState,
  ): Promise<StoredZkLoginSession> {
    if (!idToken) {
      throw new Error('Missing Apple identity token.');
    }

    return this.options.authProvider.authenticateWithJwt(idToken, {
      pendingSession: pending.pendingSession,
    });
  }

  private pruneExpiredPendingAuth(): void {
    const expiresBefore = Date.now() - PENDING_AUTH_TTL_MS;
    for (const [state, pending] of this.pendingAuth.entries()) {
      if (pending.createdAt <= expiresBefore) {
        this.pendingAuth.delete(state);
      }
    }
  }

  private setActiveOAuthConfig(provider: PortalOAuthProvider): void {
    this.options.authProvider.setOAuthConfig({
      ...this.options.authProvider.getOAuthConfig(),
      ...buildOAuthConfig(this.options.config, this.getRedirectUri(provider), provider),
    });
  }

  private getRedirectUri(provider: PortalOAuthProvider): string {
    return provider === 'apple' ? `${this.baseUrl}/auth/apple/callback` : `${this.baseUrl}/auth/callback`;
  }

  private getAuthStatus(): DaemonAuthStatus {
    const fallbackSession = this.options.authProvider.getSession();
    const expiresAt = getJwtExpiryMs(fallbackSession?.jwt);
    return this.options.getAuthStatus?.() ?? {
      authMode: 'zklogin',
      authenticated: this.options.authProvider.isAuthenticated(),
      state: this.options.authProvider.isAuthenticated() ? 'authenticated' : 'reauth_required',
      address: fallbackSession?.address ?? null,
      expiresAt,
      expiresInMs: expiresAt === null ? null : expiresAt - Date.now(),
      refreshAvailable: Boolean(fallbackSession?.refreshToken),
      lastError: null,
      updatedAt: Date.now(),
    };
  }

  private renderPage(): string {
    const authStatus = this.getAuthStatus();
    if (!this.options.authProvider.isAuthenticated()) {
      return this.options.getAuthStatus && (authStatus.state === 'expired' || authStatus.state === 'reauth_required')
        ? renderReauthPage(getConfiguredProviders(this.options.config))
        : renderWelcomePage(getConfiguredProviders(this.options.config));
    }

    return renderSetupPage({
      address: this.options.authProvider.getSession()?.address ?? '',
      dailyLimitMist: getCurrentDailyLimitMist(this.options.config),
      setupComplete: this.setupComplete,
    });
  }
}

function renderWelcomePage(providers: PortalOAuthProvider[]): string {
  const detail =
    providers.length === 0
      ? 'Configure Google or Apple sign-in to create a Sui wallet without managing private keys.'
      : providers.length === 1
        ? `Sign in with ${capitalize(providers[0])} to create a Sui wallet without managing private keys.`
        : 'Sign in with Google or Apple to create a Sui wallet without managing private keys.';

  return renderAuthPage({
    title: 'Welcome to Agentic Mesh',
    detail,
    providers,
    flow: 'setup',
  });
}

function renderReauthPage(providers: PortalOAuthProvider[]): string {
  return renderAuthPage({
    title: 'Your session has expired',
    detail: 'Re-authenticate to resume wallet-backed operations in Agentic Mesh.',
    providers,
    flow: 'reauth',
  });
}

function renderReauthCompletePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Authentication restored</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      <h1>Authentication restored</h1>
      <p>Your session is active again. This window will close automatically.</p>
    </main>
    <script>
      setTimeout(() => {
        window.close();
        setTimeout(() => {
          window.location.replace('/');
        }, 250);
      }, 150);
    </script>
  </body>
</html>`;
}

function renderAuthPage(params: {
  title: string;
  detail: string;
  providers: PortalOAuthProvider[];
  flow: PortalAuthFlow;
}): string {
  const buttons = params.providers.map((provider) => renderAuthButton(provider, params.flow)).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh Setup</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.detail)}</p>
      ${buttons ? `<div class="auth-buttons">${buttons}</div>` : '<p class="error">No OAuth providers are configured.</p>'}
    </main>
  </body>
</html>`;
}

function renderAuthButton(provider: PortalOAuthProvider, flow: PortalAuthFlow): string {
  const href = `/auth/${provider}?flow=${flow}`;
  if (provider === 'apple') {
    return `<a class="button button--apple" href="${href}"><span class="button__icon" aria-hidden="true"></span><span>Sign in with Apple</span></a>`;
  }

  return `<a class="button button--google" href="${href}"><span>Sign in with Google</span></a>`;
}

function renderSetupPage(params: { address: string; dailyLimitMist: bigint; setupComplete: boolean }): string {
  const currentLimitSui = formatMistToSui(params.dailyLimitMist);
  const successMessage = params.setupComplete ? '<p class="success">Setup complete. You can return to your app.</p>' : '';
  const title = params.setupComplete ? 'Agentic Mesh is ready' : 'Finish setup';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh Setup</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(title)}</h1>
      <p>Your Sui address:</p>
      <code>${escapeHtml(params.address)}</code>
      <label for="limit">Daily spending limit (SUI)</label>
      <input id="limit" type="range" min="1" max="100" step="1" value="${escapeHtml(currentLimitSui)}" />
      <div id="limit-value">${escapeHtml(currentLimitSui)} SUI</div>
      <button class="button" id="finish">Finish Setup</button>
      <p class="error" id="status" hidden></p>
      ${successMessage}
    </main>
    <script>
      const slider = document.getElementById('limit');
      const output = document.getElementById('limit-value');
      const button = document.getElementById('finish');
      const status = document.getElementById('status');
      slider.addEventListener('input', () => {
        output.textContent = slider.value + ' SUI';
      });
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.hidden = true;
        try {
          const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dailyLimitSui: slider.value }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(typeof body.error === 'string' ? body.error : 'Unable to save settings.');
          }
          window.location.href = '/';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Unable to save settings.';
          status.hidden = false;
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

function renderMessagePage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      <a class="button" href="/">Back</a>
    </main>
  </body>
</html>`;
}

function snapshotPortalSettings(config: DaemonFullConfig): Pick<DaemonFullConfig, 'auth' | 'payment' | 'spending'> {
  return structuredClone({
    auth: config.auth,
    payment: config.payment,
    spending: config.spending,
  });
}

function restorePortalSettings(
  target: DaemonFullConfig,
  snapshot: Pick<DaemonFullConfig, 'auth' | 'payment' | 'spending'>,
): void {
  target.auth = snapshot.auth;
  target.payment = snapshot.payment;
  target.spending = snapshot.spending;
}

function normalizeDailyLimit(body: { dailyLimitMist?: number | string; dailyLimitSui?: number | string }): bigint {
  if (body.dailyLimitMist !== undefined) {
    return parsePositiveBigInt(body.dailyLimitMist, 'dailyLimitMist');
  }

  if (body.dailyLimitSui !== undefined) {
    return parseSuiToMist(body.dailyLimitSui);
  }

  throw new Error('A daily spending limit is required.');
}

function updateDailyLimit(config: DaemonFullConfig, amountMist: bigint): void {
  const nextLimit = { amount: amountMist, interval: 'day' as const };
  const existing = config.spending.limits.findIndex((limit) => limit.interval === 'day' && !limit.scope && !limit.rail);
  if (existing >= 0) {
    config.spending.limits[existing] = nextLimit;
    return;
  }

  config.spending.limits.push(nextLimit);
}

function getCurrentDailyLimitMist(config: DaemonFullConfig): bigint {
  return config.spending.limits.find((limit) => limit.interval === 'day' && !limit.scope && !limit.rail)?.amount ?? 0n;
}

function parsePositiveBigInt(value: number | string, field: string): bigint {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  throw new Error(`${field} must be a non-negative integer.`);
}

function parseSuiToMist(value: number | string): bigint {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) {
    throw new Error('dailyLimitSui must be a valid SUI amount.');
  }

  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function formatMistToSui(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = value % 1_000_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function getSafeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return fallback;
  }

  return error.message;
}

function getOAuthErrorDetail(error: string, errorDescription?: string): string {
  return errorDescription?.trim() || error.replace(/_/g, ' ');
}

function readFlow(value: unknown): PortalAuthFlow {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const flow = (value as Record<string, unknown>).flow;
    if (flow === 'reauth') {
      return 'reauth';
    }
  }

  return 'setup';
}

function getJwtExpiryMs(jwt?: string): number | null {
  if (!jwt) {
    return null;
  }

  const [, payload] = jwt.split('.');
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const exp = parsed.exp;
    const seconds = typeof exp === 'number' ? exp : typeof exp === 'string' && /^\d+$/.test(exp) ? Number(exp) : null;
    return seconds === null ? null : seconds * 1_000;
  } catch {
    return null;
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getConfiguredProviders(config: DaemonFullConfig): PortalOAuthProvider[] {
  return (['google', 'apple'] as const).filter((provider) => isProviderConfigured(config, provider));
}

function isProviderConfigured(config: DaemonFullConfig, provider: PortalOAuthProvider): boolean {
  return provider === 'google' ? Boolean(config.auth.google?.clientId) : Boolean(config.auth.apple?.clientId);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isInputValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(dailyLimit|required|valid SUI amount|non-negative integer)/i.test(error.message)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const BASE_STYLES = `
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { width: min(480px, 92vw); background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 32px; box-shadow: 0 24px 48px rgba(15, 23, 42, 0.35); }
  h1 { margin-top: 0; }
  p, label { color: #cbd5e1; }
  code { display: block; padding: 12px; border-radius: 10px; background: #020617; overflow-wrap: anywhere; margin-bottom: 20px; }
  .button, button { display: inline-flex; justify-content: center; align-items: center; gap: 10px; border: 0; border-radius: 999px; background: #2563eb; color: white; padding: 12px 18px; text-decoration: none; font-weight: 600; cursor: pointer; }
  .auth-buttons { display: grid; gap: 12px; margin-top: 20px; }
  .button--google { background: #2563eb; }
  .button--apple { background: #000; color: #fff; border: 1px solid #1f2937; }
  .button__icon { font-size: 1.1rem; line-height: 1; }
  input[type='range'] { width: 100%; margin: 16px 0 12px; }
  .success { color: #86efac; }
  .error { color: #fca5a5; }
`;
