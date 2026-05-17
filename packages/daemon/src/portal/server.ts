import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import type { AuthProvider, OAuthConfig, StoredZkLoginSession } from '@hivemind-os/collective-core';
import { createPkcePair, type ZkLoginPendingSession } from '@hivemind-os/collective-core';

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
  authProvider?: PortalAuthProvider;
  state?: DaemonState;
  logger?: PortalLogger;
  getAuthStatus?: () => DaemonAuthStatus | null;
  getConnectedApps?: () => { appName: string; appPid: number; profile?: string; connectedAt: number }[];
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

  getReauthUrl(): string | null {
    if (!this.options.authProvider) return null;
    return `${this.baseUrl}/auth/reauth`;
  }

  private registerRoutes(): void {
    this.server.get('/', async (_request, reply) => {
      reply.type('text/html').send(this.renderPage());
    });

    // ── Dashboard routes (always available) ──────────────────────
    this.server.get('/api/status', async () => {
      const auth = this.getAuthStatus();
      const status = this.options.state?.getStatusBase();
      return {
        version: status?.version ?? null,
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

        const address =
          this.options.authProvider
            ? await this.options.authProvider.getAddress()
            : this.options.state?.address ?? '';
        return {
          ok: true,
          address,
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

    // ── Auth routes (zkLogin only) ───────────────────────────────
    if (this.options.authProvider) {
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
    }

    this.server.get('/network', async (_request, reply) => {
      reply.type('text/html').send(renderNetworkPage(this.options.config.network));
    });

    this.server.get('/api/network', async () => {
      return { ...this.options.config.network };
    });

    this.server.post('/api/network', async (request, reply) => {
      const previousNetwork = { ...this.options.config.network };

      try {
        const body = (request.body ?? {}) as {
          rpcUrl?: string;
          faucetUrl?: string;
          packageId?: string;
          registryId?: string;
        };

        const validated = validateNetworkInput(body);
        this.options.config.network = { ...this.options.config.network, ...validated };
        await saveConfig(this.options.config, this.options.configPath);
        await this.options.onSettingsSaved?.(this.options.config);
        this.options.logger?.info({ configPath: this.options.configPath }, 'Portal network config persisted');

        return { ok: true, network: { ...this.options.config.network } };
      } catch (error) {
        this.options.config.network = previousNetwork;
        const isValidation = isNetworkValidationError(error);
        if (!isValidation) {
          this.options.logger?.warn({ err: error, configPath: this.options.configPath }, 'Failed to persist network config');
        }

        return reply.code(isValidation ? 400 : 500).send({
          ok: false,
          error: getSafeErrorMessage(error, 'Unable to save network settings.'),
        });
      }
    });

    // ── Wallet page ──────────────────────────────────────────────
    this.server.get('/wallet', async (_request, reply) => {
      reply.type('text/html').send(renderWalletPage());
    });

    this.server.get('/api/wallet', async () => {
      const state = this.options.state;
      if (!state) {
        return { error: 'Daemon state not available.' };
      }

      const balanceMist = await state.suiClient.getBalance(state.address);
      return {
        did: state.did,
        address: state.address,
        balanceMist: balanceMist.toString(),
        balanceSui: formatMistToSui(balanceMist),
        spendingToday: formatMistToSui(state.spendingPolicy.getSpent('day')),
        spendingThisHour: formatMistToSui(state.spendingPolicy.getSpent('hour')),
        spendingThisMonth: formatMistToSui(state.spendingPolicy.getSpent('month')),
        dailyLimit: formatDailyLimit(this.options.config),
      };
    });

    // ── Discovery page ───────────────────────────────────────────
    this.server.get('/discover', async (_request, reply) => {
      reply.type('text/html').send(renderDiscoverPage());
    });

    this.server.get('/api/discover', async (request, reply) => {
      const state = this.options.state;
      if (!state) {
        return { error: 'Daemon state not available.' };
      }

      const query = (request.query ?? {}) as { capability?: string; limit?: string };
      const capability = (query.capability ?? '').trim();
      if (!capability) {
        return { capability: '', agents: [] };
      }
      if (capability.length > 200) {
        reply.code(400);
        return { error: 'Capability query must be 200 characters or fewer.' };
      }

      const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);
      try {
        const agents = await state.registryClient.discoverByCapability(capability, limit, {});
        return {
          capability,
          agents: agents.map((agent) => ({
            name: agent.name,
            did: agent.did,
            active: agent.active,
            capabilities: agent.capabilities.map((cap) => ({
              name: cap.name,
              priceMist: cap.pricing.amount.toString(),
              rail: cap.pricing.rail,
            })),
            endpoint: agent.endpoint,
          })),
        };
      } catch (err) {
        reply.code(502);
        return { error: 'Failed to query the registry. The network may be unavailable.', capability };
      }
    });

    // ── Tasks / Spending page ────────────────────────────────────
    this.server.get('/tasks', async (_request, reply) => {
      reply.type('text/html').send(renderTasksPage());
    });

    // ── Services page ─────────────────────────────────────────────
    this.server.get('/services', async (_request, reply) => {
      reply.type('text/html').send(renderServicesPage());
    });

    this.server.get('/api/services', async () => {
      const state = this.options.state;
      if (!state) {
        return { error: 'Daemon state not available.' };
      }

      try {
        const card = await state.registryClient.getAgentCardByOwner(state.address);
        if (!card) {
          return { registered: false, agent: null };
        }

        return {
          registered: true,
          agent: {
            name: card.name,
            did: card.did,
            active: card.active,
            endpoint: card.endpoint ?? null,
            payoutAddress: card.payoutAddress ?? null,
            capabilities: card.capabilities.map((cap) => ({
              name: cap.name,
              description: cap.description ?? null,
              priceMist: cap.pricing.amount.toString(),
              rail: cap.pricing.rail,
            })),
          },
        };
      } catch (err) {
        return { error: 'Failed to query the registry.', registered: false, agent: null };
      }
    });

    // ── Connected clients API ─────────────────────────────────────
    this.server.get('/api/clients', async () => {
      const apps = this.options.getConnectedApps?.() ?? [];
      return {
        clients: apps.map((app) => ({
          appName: app.appName,
          pid: app.appPid,
          profile: app.profile ?? null,
          connectedAt: app.connectedAt,
          connectedAgo: formatDuration(Date.now() - app.connectedAt),
        })),
      };
    });

    this.server.get('/api/tasks', async () => {
      const state = this.options.state;
      if (!state) {
        return { error: 'Daemon state not available.' };
      }

      const recentEntries = state.spendingPolicy.getRecentEntries(50).map((e) => ({
        id: e.id,
        amountSui: formatMistToSui(e.amountBaseUnits),
        rail: e.rail,
        taskId: e.taskId ?? null,
        appId: e.appId ?? null,
        timestamp: e.timestamp,
      }));

      return {
        spending: {
          hour: formatMistToSui(state.spendingPolicy.getSpent('hour')),
          day: formatMistToSui(state.spendingPolicy.getSpent('day')),
          month: formatMistToSui(state.spendingPolicy.getSpent('month')),
        },
        dailyLimit: formatDailyLimit(this.options.config),
        providerRunning: state.getStatusBase().providerRunning,
        recentEntries,
      };
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
      const authRequest = await this.options.authProvider!.createAuthorizationRequest({
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

    const tokens = await this.options.authProvider!.exchangeAuthorizationCode(
      code,
      pending.codeVerifier,
      this.getRedirectUri('google'),
    );
    return this.options.authProvider!.authenticateWithJwt(tokens.jwt, {
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

    return this.options.authProvider!.authenticateWithJwt(idToken, {
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
    this.options.authProvider!.setOAuthConfig({
      ...this.options.authProvider!.getOAuthConfig(),
      ...buildOAuthConfig(this.options.config, this.getRedirectUri(provider), provider),
    });
  }

  private getRedirectUri(provider: PortalOAuthProvider): string {
    return provider === 'apple' ? `${this.baseUrl}/auth/apple/callback` : `${this.baseUrl}/auth/callback`;
  }

  private getAuthStatus(): DaemonAuthStatus {
    if (this.options.getAuthStatus) {
      const status = this.options.getAuthStatus();
      if (status) return status;
    }

    if (!this.options.authProvider) {
      return {
        authMode: 'ed25519',
        authenticated: true,
        state: 'authenticated',
        address: this.options.state?.address ?? null,
        expiresAt: null,
        expiresInMs: null,
        refreshAvailable: false,
        lastError: null,
        updatedAt: Date.now(),
      };
    }

    const fallbackSession = this.options.authProvider.getSession();
    const expiresAt = getJwtExpiryMs(fallbackSession?.jwt);
    return {
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
    if (!this.options.authProvider) {
      // ed25519 mode — show the dashboard directly
      return renderSetupPage({
        address: this.options.state?.address ?? '',
        dailyLimitMist: getCurrentDailyLimitMist(this.options.config),
        setupComplete: true,
      });
    }

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
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
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

function renderNetworkPage(network: { rpcUrl: string; faucetUrl: string; packageId: string; registryId: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh — Network</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}${NETWORK_PAGE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
      <h1>Network Configuration</h1>
      <p>Configure which Sui network the daemon connects to.</p>

      <div class="presets">
        <button class="preset" data-rpc="https://fullnode.devnet.sui.io:443" data-faucet="https://faucet.devnet.sui.io">Devnet</button>
        <button class="preset" data-rpc="https://fullnode.testnet.sui.io:443" data-faucet="https://faucet.testnet.sui.io">Testnet</button>
        <button class="preset" data-rpc="http://127.0.0.1:9000" data-faucet="http://127.0.0.1:9123">Local</button>
      </div>

      <label for="rpcUrl">RPC URL <span class="required">*</span></label>
      <input id="rpcUrl" type="url" value="${escapeAttr(network.rpcUrl)}" placeholder="https://fullnode.devnet.sui.io:443" required />

      <label for="faucetUrl">Faucet URL</label>
      <input id="faucetUrl" type="url" value="${escapeAttr(network.faucetUrl)}" placeholder="https://faucet.devnet.sui.io" />

      <label for="packageId">Package ID</label>
      <input id="packageId" type="text" value="${escapeAttr(network.packageId)}" placeholder="0x..." />

      <label for="registryId">Registry ID</label>
      <input id="registryId" type="text" value="${escapeAttr(network.registryId)}" placeholder="0x..." />

      <p class="hint" id="hint" hidden></p>
      <button class="button" id="save">Save Network Config</button>
      <p class="error" id="status" hidden></p>
      <p class="success" id="success" hidden></p>
    </main>
    <script>
      const rpcUrl = document.getElementById('rpcUrl');
      const faucetUrl = document.getElementById('faucetUrl');
      const packageId = document.getElementById('packageId');
      const registryId = document.getElementById('registryId');
      const saveBtn = document.getElementById('save');
      const status = document.getElementById('status');
      const successEl = document.getElementById('success');
      const hint = document.getElementById('hint');

      document.querySelectorAll('.preset').forEach(btn => {
        btn.addEventListener('click', () => {
          rpcUrl.value = btn.dataset.rpc;
          faucetUrl.value = btn.dataset.faucet;
          hint.textContent = 'Preset applied to RPC and Faucet URLs. Package and Registry IDs are unchanged.';
          hint.hidden = false;
          successEl.hidden = true;
          status.hidden = true;
        });
      });

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        status.hidden = true;
        successEl.hidden = true;
        hint.hidden = true;
        try {
          const response = await fetch('/api/network', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              rpcUrl: rpcUrl.value.trim(),
              faucetUrl: faucetUrl.value.trim(),
              packageId: packageId.value.trim(),
              registryId: registryId.value.trim(),
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(typeof body.error === 'string' ? body.error : 'Unable to save network settings.');
          }
          successEl.textContent = 'Network configuration saved. The daemon will reconnect to the configured network.';
          successEl.hidden = false;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Unable to save network settings.';
          status.hidden = false;
        }
        saveBtn.disabled = false;
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

const PORTAL_NAV = `
  <nav class="nav">
    <a href="/">Settings</a> · <a href="/wallet">Wallet</a> · <a href="/services">Services</a> · <a href="/discover">Discover</a> · <a href="/tasks">Tasks</a> · <a href="/network">Network</a>
  </nav>`;

const INNER_PAGE_STYLES = `
  .nav { margin-bottom: 16px; font-size: 0.9rem; }
  .nav a { color: #60a5fa; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  .stat { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #1e293b; flex-wrap: wrap; }
  .stat:last-child { border-bottom: 0; }
  .stat-label { color: #94a3b8; font-size: 0.85rem; white-space: nowrap; }
  .stat-value { font-family: monospace; font-size: 0.9rem; word-break: break-all; text-align: right; }
  .search-row { display: flex; gap: 8px; margin-bottom: 20px; }
  .search-row input { flex: 1; padding: 10px 12px; background: #020617; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 0.9rem; }
  .search-row input:focus { outline: none; border-color: #2563eb; }
  .search-row button { flex-shrink: 0; }
  .agent-card { background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .agent-name { font-weight: 600; margin-bottom: 4px; }
  .agent-did { font-family: monospace; font-size: 0.75rem; color: #64748b; word-break: break-all; }
  .agent-cap { display: inline-block; background: #1e293b; border-radius: 6px; padding: 4px 10px; margin: 6px 4px 0 0; font-size: 0.8rem; }
  #results-empty { color: #94a3b8; font-style: italic; }
`;

function renderWalletPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh — Wallet</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
      <h1>Wallet</h1>
      <div id="loading">Loading…</div>
      <div id="content" hidden>
        <div class="stat"><span class="stat-label">Address</span><span class="stat-value" id="address"></span></div>
        <div class="stat"><span class="stat-label">DID</span><span class="stat-value" id="did"></span></div>
        <div class="stat"><span class="stat-label">Balance</span><span class="stat-value" id="balance"></span></div>
        <div class="stat"><span class="stat-label">Spent today</span><span class="stat-value" id="spent-day"></span></div>
        <div class="stat"><span class="stat-label">Spent this hour</span><span class="stat-value" id="spent-hour"></span></div>
        <div class="stat"><span class="stat-label">Spent this month</span><span class="stat-value" id="spent-month"></span></div>
        <div class="stat"><span class="stat-label">Daily limit</span><span class="stat-value" id="limit"></span></div>
      </div>
    </main>
    <script>
      (async () => {
        try {
          const res = await fetch('/api/wallet');
          const data = await res.json();
          document.getElementById('address').textContent = data.address ?? '—';
          document.getElementById('did').textContent = data.did ?? '—';
          document.getElementById('balance').textContent = (data.balanceSui ?? '—') + ' SUI';
          document.getElementById('spent-day').textContent = (data.spendingToday ?? '0') + ' SUI';
          document.getElementById('spent-hour').textContent = (data.spendingThisHour ?? '0') + ' SUI';
          document.getElementById('spent-month').textContent = (data.spendingThisMonth ?? '0') + ' SUI';
          document.getElementById('limit').textContent = data.dailyLimit ?? '—';
          document.getElementById('loading').hidden = true;
          document.getElementById('content').hidden = false;
        } catch (e) {
          document.getElementById('loading').textContent = 'Failed to load wallet data.';
        }
      })();
    </script>
  </body>
</html>`;
}

function renderDiscoverPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh — Discover</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}</style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
      <h1>Discover Agents</h1>
      <div class="search-row">
        <input id="capability" type="text" placeholder="Enter capability name…" />
        <button class="button" id="search">Search</button>
      </div>
      <div id="results"></div>
    </main>
    <script>
      const input = document.getElementById('capability');
      const btn = document.getElementById('search');
      const results = document.getElementById('results');

      async function doSearch() {
        const cap = input.value.trim();
        if (!cap) return;
        btn.disabled = true;
        results.innerHTML = '<p style="color:#94a3b8">Searching…</p>';
        try {
          const res = await fetch('/api/discover?capability=' + encodeURIComponent(cap));
          const data = await res.json();
          if (data.error) {
            results.innerHTML = '<p class="error">' + esc(data.error) + '</p>';
            return;
          }
          if (!data.agents || data.agents.length === 0) {
            results.innerHTML = '<p id="results-empty">No agents found for this capability.</p>';
            return;
          }
          results.innerHTML = data.agents.map(a => {
            const caps = (a.capabilities || []).map(c =>
              '<span class="agent-cap">' + esc(c.name) + ' — ' + esc(c.priceMist) + ' MIST</span>'
            ).join('');
            return '<div class="agent-card">' +
              '<div class="agent-name">' + esc(a.name) + (a.active ? '' : ' <span style="color:#f87171">(inactive)</span>') + '</div>' +
              '<div class="agent-did">' + esc(a.did) + '</div>' +
              (caps ? '<div>' + caps + '</div>' : '') +
              (a.endpoint ? '<div style="margin-top:6px;font-size:0.8rem;color:#64748b">' + esc(a.endpoint) + '</div>' : '') +
              '</div>';
          }).join('');
        } catch (e) {
          results.innerHTML = '<p class="error">Search failed.</p>';
        } finally {
          btn.disabled = false;
        }
      }

      btn.addEventListener('click', doSearch);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

      function esc(s) {
        const d = document.createElement('div');
        d.textContent = s ?? '';
        return d.innerHTML;
      }
    </script>
  </body>
</html>`;
}

function renderTasksPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agentic Mesh — Tasks</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}
      .tx-table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 0.82rem; }
      .tx-table th { text-align: left; color: #94a3b8; padding: 6px 8px; border-bottom: 1px solid #1e293b; }
      .tx-table td { padding: 6px 8px; border-bottom: 1px solid #0f172a; font-family: monospace; }
      .tx-table tr:hover td { background: #0f172a; }
    </style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
      <h1>Tasks &amp; Spending</h1>
      <div id="loading">Loading…</div>
      <div id="content" hidden>
        <div class="stat"><span class="stat-label">Spent this hour</span><span class="stat-value" id="hour"></span></div>
        <div class="stat"><span class="stat-label">Spent today</span><span class="stat-value" id="day"></span></div>
        <div class="stat"><span class="stat-label">Spent this month</span><span class="stat-value" id="month"></span></div>
        <div class="stat"><span class="stat-label">Daily limit</span><span class="stat-value" id="limit"></span></div>
        <div class="stat"><span class="stat-label">Provider running</span><span class="stat-value" id="provider"></span></div>
        <h2 style="margin-top:24px;font-size:1rem;">Recent Transactions</h2>
        <div id="entries"></div>
      </div>
    </main>
    <script>
      function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
      (async () => {
        try {
          const res = await fetch('/api/tasks');
          const data = await res.json();
          document.getElementById('hour').textContent = (data.spending?.hour ?? '0') + ' SUI';
          document.getElementById('day').textContent = (data.spending?.day ?? '0') + ' SUI';
          document.getElementById('month').textContent = (data.spending?.month ?? '0') + ' SUI';
          document.getElementById('limit').textContent = data.dailyLimit ?? '—';
          document.getElementById('provider').textContent = data.providerRunning ? 'Yes' : 'No';

          const entries = data.recentEntries ?? [];
          if (entries.length === 0) {
            document.getElementById('entries').innerHTML = '<p style="color:#64748b;font-style:italic">No transactions yet.</p>';
          } else {
            const rows = entries.map(e => '<tr><td>' + esc(new Date(e.timestamp).toLocaleString()) + '</td><td>' + esc(e.amountSui) + ' SUI</td><td>' + esc(e.rail) + '</td><td>' + esc(e.taskId ?? '—') + '</td><td>' + esc(e.appId ?? '—') + '</td></tr>').join('');
            document.getElementById('entries').innerHTML = '<table class="tx-table"><thead><tr><th>Time</th><th>Amount</th><th>Rail</th><th>Task</th><th>App</th></tr></thead><tbody>' + rows + '</tbody></table>';
          }

          document.getElementById('loading').hidden = true;
          document.getElementById('content').hidden = false;
        } catch (e) {
          document.getElementById('loading').textContent = 'Failed to load task data.';
        }
      })();
    </script>
  </body>
</html>`;
}

function renderServicesPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>HiveMind Collective — My Services</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}
      .cap-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 14px; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; margin-bottom: 8px; flex-wrap: wrap; }
      .cap-name { font-weight: 600; font-size: 0.9rem; }
      .cap-desc { color: #94a3b8; font-size: 0.8rem; margin-top: 2px; }
      .cap-price { font-family: monospace; font-size: 0.85rem; color: #60a5fa; white-space: nowrap; }
      .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
      .badge--active { background: #065f46; color: #6ee7b7; }
      .badge--inactive { background: #7f1d1d; color: #fca5a5; }
      .clients-section { margin-top: 32px; padding-top: 20px; border-top: 1px solid #1e293b; }
      .client-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0f172a; font-size: 0.85rem; }
      .client-name { font-weight: 600; }
      .client-meta { color: #94a3b8; font-size: 0.8rem; }
    </style>
  </head>
  <body>
    <main class="card">
      ${PORTAL_NAV}
      <h1>My Services</h1>
      <div id="loading">Loading…</div>
      <div id="content" hidden>
        <div id="registration"></div>
        <div class="clients-section">
          <h2 style="font-size:1rem;margin-bottom:12px;">Connected Clients</h2>
          <div id="clients"></div>
        </div>
      </div>
    </main>
    <script>
      function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

      async function loadServices() {
        try {
          const res = await fetch('/api/services');
          const data = await res.json();
          const el = document.getElementById('registration');

          if (data.error) {
            el.innerHTML = '<p class="error">' + esc(data.error) + '</p>';
          } else if (!data.registered) {
            el.innerHTML = '<p style="color:#94a3b8;font-style:italic">No agent registered on-chain for this wallet. Use the <code style="display:inline;padding:2px 6px">collective_register</code> tool to register.</p>';
          } else {
            const a = data.agent;
            const badge = a.active
              ? '<span class="badge badge--active">Active</span>'
              : '<span class="badge badge--inactive">Inactive</span>';
            const caps = (a.capabilities || []).map(c =>
              '<div class="cap-row"><div><div class="cap-name">' + esc(c.name) + '</div>' +
              (c.description ? '<div class="cap-desc">' + esc(c.description) + '</div>' : '') +
              '</div><div class="cap-price">' + esc(c.priceMist) + ' MIST (' + esc(c.rail) + ')</div></div>'
            ).join('');

            el.innerHTML =
              '<div class="stat"><span class="stat-label">Name</span><span class="stat-value">' + esc(a.name) + ' ' + badge + '</span></div>' +
              '<div class="stat"><span class="stat-label">DID</span><span class="stat-value">' + esc(a.did) + '</span></div>' +
              (a.endpoint ? '<div class="stat"><span class="stat-label">Endpoint</span><span class="stat-value">' + esc(a.endpoint) + '</span></div>' : '') +
              (a.payoutAddress ? '<div class="stat"><span class="stat-label">Payout Address</span><span class="stat-value">' + esc(a.payoutAddress) + '</span></div>' : '') +
              '<h2 style="font-size:1rem;margin-top:20px;margin-bottom:12px;">Capabilities (' + a.capabilities.length + ')</h2>' +
              (caps || '<p style="color:#94a3b8;font-style:italic">No capabilities registered.</p>');
          }
        } catch (e) {
          document.getElementById('registration').innerHTML = '<p class="error">Failed to load service data.</p>';
        }
      }

      async function loadClients() {
        try {
          const res = await fetch('/api/clients');
          const data = await res.json();
          const el = document.getElementById('clients');
          const clients = data.clients || [];

          if (clients.length === 0) {
            el.innerHTML = '<p style="color:#94a3b8;font-style:italic">No clients connected.</p>';
          } else {
            el.innerHTML = clients.map(c =>
              '<div class="client-row"><div><span class="client-name">' + esc(c.appName) + '</span>' +
              (c.profile ? ' <span class="client-meta">(' + esc(c.profile) + ')</span>' : '') +
              '</div><span class="client-meta">PID ' + esc(String(c.pid)) + ' · ' + esc(c.connectedAgo) + '</span></div>'
            ).join('');
          }
        } catch (e) {
          document.getElementById('clients').innerHTML = '<p class="error">Failed to load client data.</p>';
        }
      }

      Promise.all([loadServices(), loadClients()]).then(() => {
        document.getElementById('loading').hidden = true;
        document.getElementById('content').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

function formatDailyLimit(config: DaemonFullConfig): string {
  const limit = getCurrentDailyLimitMist(config);
  return limit === 0n ? 'Unlimited' : formatMistToSui(limit) + ' SUI';
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

const NETWORK_PAGE_STYLES = `
  .nav { margin-bottom: 16px; }
  .nav a { color: #60a5fa; text-decoration: none; font-size: 0.9rem; }
  .nav a:hover { text-decoration: underline; }
  .presets { display: flex; gap: 8px; margin-bottom: 20px; }
  .preset { background: #1e293b; border: 1px solid #475569; border-radius: 8px; color: #e2e8f0; padding: 8px 14px; font-size: 0.85rem; cursor: pointer; }
  .preset:hover { background: #334155; }
  label { display: block; margin-top: 16px; font-size: 0.85rem; font-weight: 600; }
  .required { color: #f87171; }
  input[type='url'], input[type='text'] { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px 12px; background: #020617; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-family: monospace; font-size: 0.85rem; }
  input[type='url']:focus, input[type='text']:focus { outline: none; border-color: #2563eb; }
  .hint { color: #94a3b8; font-size: 0.85rem; margin-top: 12px; }
  #save { margin-top: 24px; width: 100%; }
`;

function escapeAttr(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => HTML_ESCAPES[character] ?? character);
}

function validateNetworkInput(body: {
  rpcUrl?: string;
  faucetUrl?: string;
  packageId?: string;
  registryId?: string;
}): { rpcUrl: string; faucetUrl: string; packageId: string; registryId: string } {
  const rpcUrl = (body.rpcUrl ?? '').trim();
  const faucetUrl = (body.faucetUrl ?? '').trim();
  const packageId = (body.packageId ?? '').trim();
  const registryId = (body.registryId ?? '').trim();

  if (!rpcUrl) {
    throw new NetworkValidationError('RPC URL is required.');
  }

  validateHttpUrl(rpcUrl, 'RPC URL');

  if (faucetUrl) {
    validateHttpUrl(faucetUrl, 'Faucet URL');
  }

  if (packageId && !isValidHexId(packageId)) {
    throw new NetworkValidationError('Package ID must be a valid hex address starting with 0x.');
  }

  if (registryId && !isValidHexId(registryId)) {
    throw new NetworkValidationError('Registry ID must be a valid hex address starting with 0x.');
  }

  return { rpcUrl, faucetUrl, packageId, registryId };
}

function validateHttpUrl(value: string, label: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NetworkValidationError(`${label} must use http or https protocol.`);
    }
  } catch (error) {
    if (error instanceof NetworkValidationError) {
      throw error;
    }
    throw new NetworkValidationError(`${label} is not a valid URL.`);
  }
}

function isValidHexId(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

class NetworkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkValidationError';
  }
}

function isNetworkValidationError(error: unknown): boolean {
  return error instanceof NetworkValidationError;
}
