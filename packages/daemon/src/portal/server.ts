import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AuthProvider, StoredZkLoginSession } from '@agentic-mesh/core';
import { createPkcePair, type ZkLoginPendingSession } from '@agentic-mesh/core';

import type { DaemonFullConfig } from '../config.js';
import type { DaemonState } from '../state.js';

interface PendingAuthState {
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
}

export interface PortalServerOptions {
  config: DaemonFullConfig;
  authProvider: PortalAuthProvider;
  state?: DaemonState;
  onAuthenticated?: (session: StoredZkLoginSession) => Promise<void> | void;
  onSettingsSaved?: (config: DaemonFullConfig) => Promise<void> | void;
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export class PortalServer {
  private readonly server: FastifyInstance;
  private readonly pendingAuth = new Map<string, PendingAuthState>();
  private baseUrl = '';
  private setupComplete = false;
  private completionPromise: Promise<void>;
  private resolveCompletion!: () => void;

  constructor(private readonly options: PortalServerOptions) {
    this.server = Fastify({ logger: false });
    this.completionPromise = new Promise((resolvePromise) => {
      this.resolveCompletion = resolvePromise;
    });
  }

  async start(): Promise<string> {
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

  private registerRoutes(): void {
    this.server.get('/', async (_request, reply) => {
      reply.type('text/html').send(this.renderPage());
    });

    this.server.get('/auth/google', async (_request, reply) => {
      try {
        this.pruneExpiredPendingAuth();
        const state = randomBytes(16).toString('hex');
        const { verifier, challenge } = createPkcePair();
        const authRequest = await this.options.authProvider.createAuthorizationRequest({
          redirectUri: this.getRedirectUri(),
          state,
          codeChallenge: challenge,
        });

        this.pendingAuth.set(state, {
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
    });

    this.server.get('/auth/callback', async (request, reply) => {
      const {
        code,
        error,
        error_description: errorDescription,
        state,
      } = request.query as { code?: string; error?: string; error_description?: string; state?: string };
      this.pruneExpiredPendingAuth();

      if (error) {
        if (state) {
          this.pendingAuth.delete(state);
        }
        reply
          .code(400)
          .type('text/html')
          .send(renderMessagePage('Authentication failed', getOAuthErrorDetail(error, errorDescription)));
        return;
      }

      if (!code || !state) {
        reply.code(400).type('text/html').send(renderMessagePage('Authentication failed', 'Missing callback state.'));
        return;
      }

      const pending = this.pendingAuth.get(state);
      if (!pending) {
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
        const tokens = await this.options.authProvider.exchangeAuthorizationCode(
          code,
          pending.codeVerifier,
          this.getRedirectUri(),
        );
        const session = await this.options.authProvider.authenticateWithJwt(tokens.jwt, {
          pendingSession: pending.pendingSession,
          refreshToken: tokens.refreshToken,
        });
        await this.options.onAuthenticated?.(session);

        reply.type('text/html').send(this.renderPage());
      } catch (callbackError) {
        reply
          .code(502)
          .type('text/html')
          .send(renderMessagePage('Authentication failed', getSafeErrorMessage(callbackError, 'Unable to complete sign-in.')));
      }
    });

    this.server.get('/api/status', async () => ({
      authenticated: this.options.authProvider.isAuthenticated(),
      authMode: this.options.authProvider.mode,
      address: this.options.authProvider.isAuthenticated() ? await this.options.authProvider.getAddress() : null,
      did: this.options.state?.did ?? null,
      setupComplete: this.setupComplete,
      spendingLimitMist: getCurrentDailyLimitMist(this.options.config).toString(),
    }));

    this.server.post('/api/settings', async (request, reply) => {
      try {
        const body = (request.body ?? {}) as {
          dailyLimitMist?: number | string;
          dailyLimitSui?: number | string;
        };
        const nextLimit = normalizeDailyLimit(body);
        updateDailyLimit(this.options.config, nextLimit);
        this.options.state?.spendingPolicy.updatePolicy(this.options.config.spending);
        await this.options.onSettingsSaved?.(this.options.config);
        this.setupComplete = true;
        this.resolveCompletion();

        return {
          ok: true,
          address: await this.options.authProvider.getAddress(),
          spendingLimitMist: nextLimit.toString(),
        };
      } catch (error) {
        return reply.code(isInputValidationError(error) ? 400 : 500).send({
          ok: false,
          error: getSafeErrorMessage(error, 'Unable to save settings.'),
        });
      }
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

  private getRedirectUri(): string {
    return `${this.baseUrl}/auth/callback`;
  }

  private renderPage(): string {
    if (!this.options.authProvider.isAuthenticated()) {
      return renderWelcomePage();
    }

    return renderSetupPage({
      address: this.options.authProvider.getSession()?.address ?? '',
      dailyLimitMist: getCurrentDailyLimitMist(this.options.config),
      setupComplete: this.setupComplete,
    });
  }
}

function renderWelcomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh Setup</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      <h1>Welcome to Agentic Mesh</h1>
      <p>Sign in with Google to create a Sui wallet without managing private keys.</p>
      <a class="button" href="/auth/google">Sign in with Google</a>
    </main>
  </body>
</html>`;
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
  .button, button { display: inline-flex; justify-content: center; align-items: center; border: 0; border-radius: 999px; background: #2563eb; color: white; padding: 12px 18px; text-decoration: none; font-weight: 600; cursor: pointer; }
  input[type='range'] { width: 100%; margin: 16px 0 12px; }
  .success { color: #86efac; }
  .error { color: #fca5a5; }
`;
