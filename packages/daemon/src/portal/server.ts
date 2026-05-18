import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import type { AuthProvider, OAuthConfig, StoredZkLoginSession } from '@hivemind-os/collective-core';
import { createPkcePair, type ZkLoginPendingSession } from '@hivemind-os/collective-core';
import { NETWORK_PRESETS, PaymentRail, type NetworkName } from '@hivemind-os/collective-types';

import { saveConfig, type DaemonFullConfig } from '../config.js';
import type { DaemonAuthStatus } from '../auth/session-monitor.js';
import { buildOAuthConfig, type DaemonState } from '../state.js';

type PortalOAuthProvider = OAuthConfig['provider'];
type PortalProviderConfig = NonNullable<DaemonFullConfig['provider']>;
type PortalProviderCapability = PortalProviderConfig['capabilities'][number];

type PortalAuthFlow = 'setup' | 'reauth';

type PortalFullSettings = {
  daemon: Pick<DaemonFullConfig['daemon'], 'logLevel' | 'dataDir' | 'pidFile'>;
  relay: Pick<DaemonFullConfig['relay'], 'autoConnect' | 'providerMode'> & { endpoints: string[] };
  encryption: DaemonFullConfig['encryption'];
  spending: {
    allowedApps: string[];
    deniedApps: string[];
  };
};

type PortalSettingsUpdate = {
  dailyLimitMist: bigint;
  relay: Pick<DaemonFullConfig['relay'], 'autoConnect' | 'providerMode' | 'endpoints'>;
  encryption: DaemonFullConfig['encryption'];
  spending: {
    allowlist?: string[];
    denylist?: string[];
  };
};

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
  disconnectClient?: (pid: number) => boolean;
  getJobQueue?: () => import('../provider/adapters/job-queue.js').JobQueueAdapter | undefined;
  getProviderRuntime?: () => import('../provider/runtime.js').ProviderRuntime | undefined;
  onAuthenticated?: (session: StoredZkLoginSession) => Promise<void> | void;
  onSettingsSaved?: (config: DaemonFullConfig) => Promise<void> | void;
  onProviderConfigChanged?: () => Promise<void> | void;
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

    this.server.get('/api/provider/status', async () => {
      const providerRuntime = this.options.getProviderRuntime?.();
      return {
        status: providerRuntime?.registrationStatus.status ?? 'idle',
        error: providerRuntime?.registrationStatus.error ?? null,
        capabilities: providerRuntime?.capabilityCount ?? 0,
        queueDepth: providerRuntime?.queueDepth ?? 0,
      };
    });

    this.server.get('/api/full-settings', async () => {
      return getPortalFullSettings(this.options.config);
    });

    const savePortalSettings = async (request: { body?: unknown }, reply: FastifyReply) => {
      const previousSettings = snapshotPortalSettings(this.options.config);

      try {
        const nextSettings = validatePortalSettingsInput(request.body, this.options.config);
        updateDailyLimit(this.options.config, nextSettings.dailyLimitMist);
        this.options.config.relay = { ...this.options.config.relay, ...nextSettings.relay };
        this.options.config.encryption = { ...nextSettings.encryption };
        this.options.config.spending = {
          ...this.options.config.spending,
          allowlist: nextSettings.spending.allowlist,
          denylist: nextSettings.spending.denylist,
        };
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
          spendingLimitMist: nextSettings.dailyLimitMist.toString(),
          settings: getPortalFullSettings(this.options.config),
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
    };

    this.server.post('/api/settings', savePortalSettings);
    this.server.post('/api/full-settings', savePortalSettings);

    // ── Auth routes (zkLogin only) ───────────────────────────────
    if (this.options.authProvider) {
      this.server.get('/auth/reauth', async (_request, reply) => {
        reply.type('text/html').send(wrapInLayout('Session expired', 'settings', renderReauthPage(getConfiguredProviders(this.options.config))));
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
      reply.type('text/html').send(wrapInLayout('Network', 'network', renderNetworkPage(this.options.config.network)));
    });

    this.server.get('/api/network', async () => {
      return { ...this.options.config.network };
    });

    this.server.post('/api/network', async (request, reply) => {
      const previousNetwork = { ...this.options.config.network };

      try {
        const body = (request.body ?? {}) as {
          preset?: string;
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
      reply.type('text/html').send(wrapInLayout('Wallet', 'wallet', renderWalletPage()));
    });

    this.server.get('/api/wallet', async () => {
      const state = this.options.state;
      if (!state) {
        return { error: 'Daemon state not available.' };
      }

      const balanceMist = await state.suiClient.getBalance(state.address);
      const network = this.options.config.network;
      const presetName = network.preset || detectPreset(network);
      const preset = presetName ? (NETWORK_PRESETS as Record<string, { explorerUrl?: string; faucetUrl?: string }>)[presetName] : undefined;
      return {
        did: state.did,
        address: state.address,
        balanceMist: balanceMist.toString(),
        balanceSui: formatMistToSui(balanceMist),
        spendingToday: formatMistToSui(state.spendingPolicy.getSpent('day')),
        spendingThisHour: formatMistToSui(state.spendingPolicy.getSpent('hour')),
        spendingThisMonth: formatMistToSui(state.spendingPolicy.getSpent('month')),
        dailyLimit: formatDailyLimit(this.options.config),
        explorerUrl: preset?.explorerUrl || '',
        faucetUrl: network.faucetUrl || preset?.faucetUrl || '',
      };
    });

    // ── Discovery page ───────────────────────────────────────────
    this.server.get('/discover', async (_request, reply) => {
      reply.type('text/html').send(wrapInLayout('Discover', 'discover', renderDiscoverPage()));
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
      reply.type('text/html').send(wrapInLayout('Tasks', 'tasks', renderTasksPage()));
    });

    // ── Services page ─────────────────────────────────────────────
    this.server.get('/services', async (_request, reply) => {
      reply.type('text/html').send(wrapInLayout('Services', 'services', renderServicesPage()));
    });

    this.server.get('/queue', async (_request, reply) => {
      reply.type('text/html').send(wrapInLayout('Queue', 'queue', renderQueuePage()));
    });

    this.server.get('/api/provider/config', async () => {
      return getProviderConfigForPortal(this.options.config);
    });

    this.server.post('/api/provider/config', async (request, reply) => {
      const previousProvider = this.options.config.provider;
      const programmaticCapabilities = (previousProvider?.capabilities ?? []).filter((capability) => capability.adapter === 'local-function');

      try {
        const validated = validateProviderConfigInput(request.body);
        this.options.config.provider = validated;
        await saveConfig(this.options.config, this.options.configPath);

        if (programmaticCapabilities.length > 0) {
          this.options.config.provider = {
            ...validated,
            capabilities: [...validated.capabilities, ...programmaticCapabilities],
          };
        }

        this.options.logger?.info({ configPath: this.options.configPath }, 'Portal provider config persisted');

        try {
          await this.options.onProviderConfigChanged?.();
        } catch (error) {
          this.options.logger?.warn({ err: error, configPath: this.options.configPath }, 'Provider restart callback failed');
          return reply.code(500).send({
            ok: false,
            error: getSafeErrorMessage(error, 'Provider configuration was saved, but the provider could not be restarted.'),
          });
        }

        return { ok: true };
      } catch (error) {
        this.options.config.provider = previousProvider;
        const isValidation = isProviderConfigValidationError(error);
        if (!isValidation) {
          this.options.logger?.warn({ err: error, configPath: this.options.configPath }, 'Failed to persist provider config');
        }

        return reply.code(isValidation ? 400 : 500).send({
          ok: false,
          error: getSafeErrorMessage(error, 'Unable to save provider settings.'),
        });
      }
    });

    // ── Work queue API ───────────────────────────────────────────────
    this.server.get('/api/work-queue', async (request) => {
      const queue = this.options.getJobQueue?.();
      if (!queue) {
        return { items: [], count: 0 };
      }
      const query = (request.query ?? {}) as { status?: string };
      const filter = query.status ? { status: query.status } : undefined;
      const items = queue.list(filter);
      return { items, count: items.length };
    });

    this.server.post('/api/work-queue/:id/retry', async (request, reply) => {
      const queue = this.options.getJobQueue?.();
      if (!queue) {
        return reply.code(404).send({ ok: false, error: 'Work queue is not active.' });
      }
      const { id } = request.params as { id: string };
      const result = queue.retry(id);
      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    });

    this.server.delete('/api/work-queue/:id', async (request, reply) => {
      const queue = this.options.getJobQueue?.();
      if (!queue) {
        return reply.code(404).send({ ok: false, error: 'Work queue is not active.' });
      }
      const { id } = request.params as { id: string };
      const result = queue.remove(id);
      if (!result.ok) {
        return reply.code(404).send(result);
      }
      return result;
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

    // ── Registration actions ─────────────────────────────────────
    this.server.post('/api/provider/register', async (_request, reply) => {
      const state = this.options.state;
      if (!state) {
        return reply.code(500).send({ error: 'Daemon state not available.' });
      }
      const providerConfig = this.options.config.provider;
      if (!providerConfig?.capabilities?.length) {
        return reply.code(400).send({ error: 'No capabilities configured. Add capabilities in Provider Services first.' });
      }
      try {
        const capabilities = providerConfig.capabilities.map((c) => ({
          name: c.name,
          description: c.description,
          version: c.version,
          pricing: { rail: (c.currency === 'USDC' ? PaymentRail.USDC_ESCROW : PaymentRail.SUI_ESCROW), amount: BigInt(c.priceMist ?? 0), currency: c.currency || 'USDC' },
        }));
        const result = await state.registryClient.registerAgent({
          name: 'Agentic Mesh Provider',
          description: `Provider for ${state.did}`,
          did: state.did,
          capabilities,
          endpoint: `mesh://agent/${state.did}`,
          keypair: state.keypair,
        });
        return { ok: true, agentCardId: result.agentCardId, txDigest: result.txDigest };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Registration failed.';
        return reply.code(500).send({ error: msg });
      }
    });

    this.server.post('/api/provider/unregister', async (_request, reply) => {
      const state = this.options.state;
      if (!state) {
        return reply.code(500).send({ error: 'Daemon state not available.' });
      }
      try {
        const card = await state.registryClient.getAgentCardByOwner(state.address);
        if (!card) {
          return reply.code(404).send({ error: 'No agent card found to unregister.' });
        }
        await state.registryClient.deactivateAgent({ cardId: card.id, keypair: state.keypair });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unregistration failed.';
        return reply.code(500).send({ error: msg });
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

    this.server.delete('/api/clients/:pid', async (request, reply) => {
      const { pid } = request.params as { pid: string };
      const numPid = parseInt(pid, 10);
      if (isNaN(numPid)) {
        return reply.code(400).send({ error: 'Invalid PID.' });
      }
      const disconnected = this.options.disconnectClient?.(numPid) ?? false;
      if (!disconnected) {
        return reply.code(404).send({ error: 'Client not found.' });
      }
      return { ok: true };
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
    const version = this.options.state?.getStatusBase().version;
    if (!this.options.authProvider) {
      return wrapInLayout(
        'HiveMind Collective',
        'settings',
        renderSetupPage({
          address: this.options.state?.address ?? '',
          dailyLimitMist: getCurrentDailyLimitMist(this.options.config),
          setupComplete: true,
          version,
        }),
      );
    }

    const authStatus = this.getAuthStatus();
    if (!this.options.authProvider.isAuthenticated()) {
      return wrapInLayout(
        authStatus.state === 'expired' || authStatus.state === 'reauth_required' ? 'Session expired' : 'Agentic Mesh Setup',
        'settings',
        this.options.getAuthStatus && (authStatus.state === 'expired' || authStatus.state === 'reauth_required')
          ? renderReauthPage(getConfiguredProviders(this.options.config))
          : renderWelcomePage(getConfiguredProviders(this.options.config)),
      );
    }

    return wrapInLayout(
      'HiveMind Collective',
      'settings',
      renderSetupPage({
        address: this.options.authProvider.getSession()?.address ?? '',
        dailyLimitMist: getCurrentDailyLimitMist(this.options.config),
        setupComplete: this.setupComplete,
        version,
      }),
    );
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
  return wrapInLayout(
    'Authentication restored',
    'settings',
    `
      <section class="hero-card">
        <div class="hero-card__content">
          <span class="pill pill--success">Session active</span>
          <h1>Authentication restored</h1>
          <p>Your session is active again. This window will close automatically.</p>
        </div>
      </section>
      <script>
        setTimeout(() => {
          window.close();
          setTimeout(() => {
            window.location.replace('/');
          }, 250);
        }, 150);
      </script>
    `,
  );
}

function renderAuthPage(params: {
  title: string;
  detail: string;
  providers: PortalOAuthProvider[];
  flow: PortalAuthFlow;
}): string {
  const buttons = params.providers.map((provider) => renderAuthButton(provider, params.flow)).join('');
  const badge = params.flow === 'reauth' ? 'Re-authentication required' : 'Local portal setup';

  return `
    <section class="hero-card">
      <div class="hero-card__content">
        <span class="pill pill--accent">${escapeHtml(badge)}</span>
        <h1>${escapeHtml(params.title)}</h1>
        <p>${escapeHtml(params.detail)}</p>
      </div>
      ${buttons ? `<div class="auth-buttons">${buttons}</div>` : '<div class="notice notice--error">No OAuth providers are configured.</div>'}
    </section>`;
}

function renderAuthButton(provider: PortalOAuthProvider, flow: PortalAuthFlow): string {
  const href = `/auth/${provider}?flow=${flow}`;
  if (provider === 'apple') {
    return `<a class="button button--secondary button--apple" href="${escapeAttr(href)}"><span class="button__icon" aria-hidden="true"></span><span>Sign in with Apple</span></a>`;
  }

  return `<a class="button" href="${escapeAttr(href)}"><span class="button__icon" aria-hidden="true">◎</span><span>Sign in with Google</span></a>`;
}

function renderSetupPage(params: { address: string; dailyLimitMist: bigint; setupComplete: boolean; version?: string }): string {
  const currentLimitSui = formatMistToSui(params.dailyLimitMist || 1n) || '1';
  const title = params.setupComplete ? 'HiveMind Collective' : 'Finish setup';
  const buttonLabel = params.setupComplete ? 'Save portal settings' : 'Finish setup';
  const versionBadge = params.version ? `<span class="pill">v${escapeHtml(params.version)}</span>` : '';
  const successMessage = params.setupComplete ? '<div class="notice notice--success">Setup complete. You can return to your app at any time.</div>' : '';
  const versionValue = params.version ? `v${escapeHtml(params.version)}` : 'Unavailable';

  return `
    <section class="page-header">
      <div class="page-header__content">
        <div class="title-row">
          <h1>${escapeHtml(title)}</h1>
          ${versionBadge}
        </div>
        <p>Configure your local HiveMind Collective daemon, wallet spending limits, and portal access from this localhost-only control plane.</p>
      </div>
    </section>
    <section class="card stack">
      ${successMessage}
      <div class="grid grid--2">
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Wallet identity</h2>
              <p>The current portal is bound to the wallet below.</p>
            </div>
          </div>
          <div class="code-block mono">${escapeHtml(params.address || 'Not available')}</div>
        </div>
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Daily spending limit</h2>
              <p>Control how much the daemon can spend in a single day.</p>
            </div>
          </div>
          <label for="limit">
            Spending limit (SUI)
            <span class="field-hint">Choose a value between 1 and 100 SUI.</span>
          </label>
          <input id="limit" type="range" min="1" max="100" step="1" value="${escapeAttr(currentLimitSui)}" />
          <div class="range-footer">
            <span class="pill pill--accent" id="limit-value">${escapeHtml(currentLimitSui)} SUI</span>
          </div>
        </div>
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Daemon info</h2>
              <p>Inspect the local daemon runtime and file locations.</p>
            </div>
          </div>
          <div class="stat-list">
            <div class="stat"><span class="stat-label">Daemon version</span><span class="stat-value mono">${versionValue}</span></div>
            <div class="stat"><span class="stat-label">Log level</span><span class="stat-value" id="daemon-log-level">Loading…</span></div>
            <div class="stat"><span class="stat-label">Data directory</span><span class="stat-value mono" id="daemon-data-dir">Loading…</span></div>
            <div class="stat"><span class="stat-label">PID file path</span><span class="stat-value mono" id="daemon-pid-file">Loading…</span></div>
          </div>
        </div>
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Relay settings</h2>
              <p>Control how the daemon connects to configured relay services.</p>
            </div>
          </div>
          <label for="relay-auto-connect">
            <span><input type="checkbox" id="relay-auto-connect" />Auto-connect</span>
            <span class="field-hint">Reconnect automatically to saved relay endpoints.</span>
          </label>
          <label for="relay-provider-mode">
            <span><input type="checkbox" id="relay-provider-mode" />Provider mode</span>
            <span class="field-hint">Advertise provider capabilities over relay connections.</span>
          </label>
          <label for="relay-endpoints">
            Relay endpoints
            <span class="field-hint">Enter one ws:// or wss:// relay URL per line.</span>
            <textarea id="relay-endpoints" rows="4" placeholder="wss://relay.example.com/v1/ws"></textarea>
          </label>
        </div>
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Encryption settings</h2>
              <p>Choose whether local execution requires encrypted payloads.</p>
            </div>
          </div>
          <label for="encryption-enabled">
            <span><input type="checkbox" id="encryption-enabled" />Enabled</span>
            <span class="field-hint">Encrypt supported daemon traffic with the local keypair.</span>
          </label>
          <label for="require-encryption">
            <span><input type="checkbox" id="require-encryption" />Require encryption</span>
            <span class="field-hint">Reject requests that do not include encryption metadata.</span>
          </label>
        </div>
        <div class="surface stack stack--tight">
          <div class="section-header section-header--compact">
            <div>
              <h2>Spending policy</h2>
              <p>Allow or block specific apps in addition to the global daily limit.</p>
            </div>
          </div>
          <label for="allowed-apps">
            Per-app allowlist
            <span class="field-hint">One app name per line. Leave blank to allow all apps.</span>
            <textarea id="allowed-apps" rows="4" placeholder="my-app"></textarea>
          </label>
          <label for="denied-apps">
            Per-app denylist
            <span class="field-hint">One app name per line. Matching apps are always blocked.</span>
            <textarea id="denied-apps" rows="4" placeholder="untrusted-app"></textarea>
          </label>
          <div class="top-actions">
            <button class="button" id="finish" disabled>${escapeHtml(buttonLabel)}</button>
          </div>
          <div class="notice notice--error" id="status" hidden></div>
        </div>
      </div>
    </section>
    <script>
      const slider = document.getElementById('limit');
      const output = document.getElementById('limit-value');
      const button = document.getElementById('finish');
      const status = document.getElementById('status');
      const relayAutoConnect = document.getElementById('relay-auto-connect');
      const relayProviderMode = document.getElementById('relay-provider-mode');
      const relayEndpoints = document.getElementById('relay-endpoints');
      const encryptionEnabled = document.getElementById('encryption-enabled');
      const requireEncryption = document.getElementById('require-encryption');
      const allowedApps = document.getElementById('allowed-apps');
      const deniedApps = document.getElementById('denied-apps');
      let settingsLoaded = false;

      function setText(id, value) {
        const element = document.getElementById(id);
        if (element) {
          element.textContent = value || 'Unavailable';
        }
      }

      function splitLines(value) {
        return value
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }

      function syncEncryptionState() {
        if (!encryptionEnabled.checked) {
          requireEncryption.checked = false;
        }
        requireEncryption.disabled = !encryptionEnabled.checked;
      }

      slider.addEventListener('input', () => {
        output.textContent = slider.value + ' SUI';
      });

      encryptionEnabled.addEventListener('change', syncEncryptionState);

      async function loadSettings() {
        status.hidden = true;
        try {
          const response = await fetch('/api/full-settings');
          if (!response.ok) {
            throw new Error('Unable to load settings.');
          }
          const body = await response.json();
          setText('daemon-log-level', body.daemon && body.daemon.logLevel ? body.daemon.logLevel : 'Unavailable');
          setText('daemon-data-dir', body.daemon && body.daemon.dataDir ? body.daemon.dataDir : 'Unavailable');
          setText('daemon-pid-file', body.daemon && body.daemon.pidFile ? body.daemon.pidFile : 'Unavailable');
          relayAutoConnect.checked = Boolean(body.relay && body.relay.autoConnect);
          relayProviderMode.checked = Boolean(body.relay && body.relay.providerMode);
          relayEndpoints.value = Array.isArray(body.relay && body.relay.endpoints) ? body.relay.endpoints.join('\n') : '';
          encryptionEnabled.checked = Boolean(body.encryption && body.encryption.enabled);
          requireEncryption.checked = Boolean(body.encryption && body.encryption.requireEncryption);
          allowedApps.value = Array.isArray(body.spending && body.spending.allowedApps) ? body.spending.allowedApps.join('\n') : '';
          deniedApps.value = Array.isArray(body.spending && body.spending.deniedApps) ? body.spending.deniedApps.join('\n') : '';
          syncEncryptionState();
          settingsLoaded = true;
          button.disabled = false;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Unable to load settings.';
          status.hidden = false;
        }
      }

      button.addEventListener('click', async () => {
        if (!settingsLoaded) {
          return;
        }
        button.disabled = true;
        status.hidden = true;
        try {
          const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dailyLimitSui: slider.value,
              relay: {
                autoConnect: relayAutoConnect.checked,
                providerMode: relayProviderMode.checked,
                endpoints: splitLines(relayEndpoints.value),
              },
              encryption: {
                enabled: encryptionEnabled.checked,
                requireEncryption: requireEncryption.checked,
              },
              spending: {
                allowedApps: splitLines(allowedApps.value),
                deniedApps: splitLines(deniedApps.value),
              },
            }),
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

      void loadSettings();
    </script>`;
}

function renderNetworkPage(network: { preset?: string; rpcUrl: string; faucetUrl: string; packageId: string; registryId: string }): string {
  const presetNames: Array<NetworkName | 'custom'> = ['testnet', 'mainnet', 'devnet', 'local', 'custom'];
  const currentPreset = network.preset || detectPreset(network) || 'custom';

  const presetsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(NETWORK_PRESETS).map(([k, v]) => [
        k,
        { rpcUrl: v.rpcUrl, faucetUrl: v.faucetUrl, packageId: v.packageId, registryId: v.registryId, explorerUrl: v.explorerUrl },
      ]),
    ),
  );

  const networkOptions = presetNames
    .map((n) => {
      const label = n === 'custom' ? 'Custom' : n.charAt(0).toUpperCase() + n.slice(1);
      const selected = n === currentPreset ? ' selected' : '';
      return `<option value="${n}"${selected}>${label}</option>`;
    })
    .join('');

  return `
    <section class="page-header">
      <div class="page-header__content">
        <h1>Network</h1>
        <p>Select a Sui network. Each network has its own contract deployment and registry.</p>
      </div>
    </section>
    <section class="card stack">
      <div class="section-header section-header--compact">
        <div>
          <h2>Active network</h2>
          <p>Choose a preset or configure a custom endpoint.</p>
        </div>
      </div>
      <label for="preset">
        Network
        <select id="preset">
          ${networkOptions}
        </select>
      </label>
      <div id="preset-note" class="notice" hidden></div>
      <div class="grid grid--2">
        <label for="rpcUrl">
          RPC URL <span class="required">*</span>
          <input id="rpcUrl" type="url" value="${escapeAttr(network.rpcUrl)}" placeholder="https://fullnode.testnet.sui.io:443" required />
        </label>
        <label for="faucetUrl">
          Faucet URL
          <input id="faucetUrl" type="url" value="${escapeAttr(network.faucetUrl)}" placeholder="https://faucet.testnet.sui.io" />
        </label>
      </div>
      <div class="grid grid--2">
        <label for="packageId">
          Package ID <span class="hint">(contract deployment)</span> <a id="packageId-link" class="hint" target="_blank" rel="noopener" hidden>↗ Explorer</a>
          <input id="packageId" type="text" value="${escapeAttr(network.packageId)}" placeholder="0x..." />
        </label>
        <label for="registryId">
          Registry ID <span class="hint">(on-chain registry object)</span> <a id="registryId-link" class="hint" target="_blank" rel="noopener" hidden>↗ Explorer</a>
          <input id="registryId" type="text" value="${escapeAttr(network.registryId)}" placeholder="0x..." />
        </label>
      </div>
      <div class="top-actions">
        <button class="button" id="save">Save</button>
      </div>
      <div class="notice notice--error" id="status" hidden></div>
      <div class="notice notice--success" id="success" hidden></div>
    </section>
    <script>
      const PRESETS = ${presetsJson};
      const presetEl = document.getElementById('preset');
      const rpcUrl = document.getElementById('rpcUrl');
      const faucetUrl = document.getElementById('faucetUrl');
      const packageId = document.getElementById('packageId');
      const registryId = document.getElementById('registryId');
      const saveBtn = document.getElementById('save');
      const status = document.getElementById('status');
      const successEl = document.getElementById('success');
      const presetNote = document.getElementById('preset-note');
      const packageIdLink = document.getElementById('packageId-link');
      const registryIdLink = document.getElementById('registryId-link');

      function applyPreset(name) {
        const p = PRESETS[name];
        if (!p) return;
        rpcUrl.value = p.rpcUrl;
        faucetUrl.value = p.faucetUrl;
        packageId.value = p.packageId;
        registryId.value = p.registryId;
        updateFieldState(name);
      }

      function updateFieldState(name) {
        const isCustom = name === 'custom';
        const fields = [rpcUrl, faucetUrl, packageId, registryId];
        fields.forEach(f => {
          f.readOnly = !isCustom;
          f.style.opacity = isCustom ? '1' : '0.7';
          f.style.cursor = isCustom ? '' : 'default';
        });
        const p = PRESETS[name];
        if (!isCustom && p && !p.packageId) {
          presetNote.textContent = 'This network does not have deployed contracts yet. Package ID and Registry ID are empty.';
          presetNote.className = 'notice notice--warning';
          presetNote.hidden = false;
        } else {
          presetNote.hidden = true;
        }
        // Update explorer links
        const explorerBase = p?.explorerUrl || '';
        if (explorerBase && packageId.value) {
          packageIdLink.href = explorerBase + '/object/' + packageId.value;
          packageIdLink.hidden = false;
        } else {
          packageIdLink.hidden = true;
        }
        if (explorerBase && registryId.value) {
          registryIdLink.href = explorerBase + '/object/' + registryId.value;
          registryIdLink.hidden = false;
        } else {
          registryIdLink.hidden = true;
        }
      }

      presetEl.addEventListener('change', () => {
        const name = presetEl.value;
        if (name !== 'custom') {
          applyPreset(name);
        } else {
          updateFieldState('custom');
        }
        successEl.hidden = true;
        status.hidden = true;
      });

      // Initialize field state
      updateFieldState(presetEl.value);

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        status.hidden = true;
        successEl.hidden = true;
        try {
          const response = await fetch('/api/network', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              preset: presetEl.value,
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
          successEl.textContent = 'Network settings saved. The daemon will reconnect.';
          successEl.hidden = false;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Unable to save network settings.';
          status.hidden = false;
        }
        saveBtn.disabled = false;
      });
    </script>`;
}

function detectPreset(network: { rpcUrl: string; packageId: string; registryId: string }): string | undefined {
  for (const [name, preset] of Object.entries(NETWORK_PRESETS)) {
    if (preset.rpcUrl === network.rpcUrl && preset.packageId === network.packageId && preset.registryId === network.registryId) {
      return name;
    }
  }
  return undefined;
}

function renderMessagePage(title: string, detail: string): string {
  return wrapInLayout(
    title,
    'settings',
    `
      <section class="hero-card">
        <div class="hero-card__content">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(detail)}</p>
        </div>
        <div class="top-actions">
          <a class="button" href="/">Back to portal</a>
        </div>
      </section>
    `,
  );
}

const PORTAL_NAV = [
  { id: 'settings', href: '/', icon: '⚙', label: 'Settings' },
  { id: 'wallet', href: '/wallet', icon: '👛', label: 'Wallet' },
  { id: 'services', href: '/services', icon: '🧩', label: 'Services' },
  { id: 'queue', href: '/queue', icon: '📥', label: 'Queue' },
  { id: 'discover', href: '/discover', icon: '🔎', label: 'Discover' },
  { id: 'tasks', href: '/tasks', icon: '📋', label: 'Tasks' },
  { id: 'network', href: '/network', icon: '🌐', label: 'Network' },
] as const;

const INNER_PAGE_STYLES = `
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-header__content { display: grid; gap: 10px; }
  .title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .stack { display: grid; gap: 24px; }
  .stack--tight { gap: 16px; }
  .surface { display: grid; gap: 16px; padding: 20px; border-radius: 16px; background: #0b1220; border: 1px solid #1e293b; }
  .surface--muted { background: rgba(15, 22, 40, 0.85); }
  .section-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .section-header--compact h2, .section-header--compact h3 { margin-bottom: 6px; }
  .top-actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .grid { display: grid; gap: 16px; }
  .grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .code-block { padding: 16px; border-radius: 14px; background: #09101c; border: 1px solid #1e293b; color: #cbd5e1; overflow-wrap: anywhere; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .range-footer { display: flex; justify-content: flex-start; }
  .preset-list { display: flex; gap: 12px; flex-wrap: wrap; }
  .required { color: #ef4444; }
  .hint { font-weight: 400; font-size: 0.85em; color: #94a3b8; margin-left: 4px; }
  .hero-card { max-width: 720px; display: grid; gap: 20px; padding: 32px; border-radius: 24px; border: 1px solid #1e293b; background: linear-gradient(180deg, rgba(17, 24, 39, 0.96), rgba(11, 18, 32, 0.92)); box-shadow: 0 24px 60px rgba(2, 6, 23, 0.45); }
  .hero-card__content { display: grid; gap: 16px; }
  .auth-buttons { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-list { display: grid; gap: 0; }
  .stat { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 16px 0; border-bottom: 1px solid #1e293b; flex-wrap: wrap; }
  .stat:last-child { border-bottom: 0; }
  .stat-label { color: #94a3b8; font-size: 0.92rem; }
  .stat-value { color: #e2e8f0; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
  .search-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .search-row input { flex: 1 1 280px; }
  .agent-grid { display: grid; gap: 16px; }
  .agent-card { display: grid; gap: 12px; padding: 20px; border-radius: 16px; border: 1px solid #1e293b; background: #0b1220; }
  .agent-name { display: flex; align-items: center; gap: 10px; font-size: 1rem; font-weight: 700; }
  .agent-did { color: #94a3b8; font-size: 0.88rem; overflow-wrap: anywhere; }
  .agent-details summary { cursor: pointer; color: #94a3b8; font-size: 0.85rem; margin-top: 4px; }
  .agent-details[open] summary { margin-bottom: 8px; }
  .detail-row td { padding-top: 0 !important; border-bottom: none !important; }
  .detail-row details summary { cursor: pointer; color: #94a3b8; font-size: 0.82rem; }
  .tag-list { display: flex; gap: 8px; flex-wrap: wrap; }
  .tag { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.24); color: #bfdbfe; font-size: 0.82rem; }
  .table-wrap { overflow-x: auto; }
  .tx-table { width: 100%; border-collapse: collapse; min-width: 640px; }
  .tx-table th, .tx-table td { padding: 12px 14px; border-bottom: 1px solid #1e293b; text-align: left; }
  .tx-table th { color: #94a3b8; font-size: 0.84rem; font-weight: 600; }
  .tx-table td { color: #e2e8f0; font-size: 0.9rem; }
  .tx-table tbody tr:hover td { background: rgba(30, 41, 59, 0.42); }
  .clients-list { display: grid; gap: 12px; }
  .client-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px; border-radius: 14px; border: 1px solid #1e293b; background: #0b1220; flex-wrap: wrap; }
  .client-name { font-weight: 600; }
  .client-meta { color: #94a3b8; font-size: 0.88rem; }
  .provider-layout { display: grid; gap: 20px; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr); }
  .capability-list { display: grid; gap: 12px; }
  .capability-card { display: grid; gap: 14px; }
  .capability-card__title { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .capability-card__meta { display: flex; gap: 8px; flex-wrap: wrap; }
  .capability-card__description { color: #cbd5e1; }
  .switch-row { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 18px 20px; border-radius: 16px; background: #0b1220; border: 1px solid #1e293b; }
  .switch-row__copy { display: grid; gap: 6px; }
  .switch-row__copy p { color: #94a3b8; }
  .switch { position: relative; width: 54px; height: 32px; display: inline-flex; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch__slider { position: absolute; inset: 0; cursor: pointer; border-radius: 999px; background: #334155; transition: background 0.2s ease; }
  .switch__slider::before { content: ''; position: absolute; left: 4px; top: 4px; width: 24px; height: 24px; border-radius: 50%; background: white; transition: transform 0.2s ease; }
  .switch input:checked + .switch__slider { background: #3b82f6; }
  .switch input:checked + .switch__slider::before { transform: translateX(22px); }
  .empty-state { padding: 20px; border-radius: 14px; border: 1px dashed #334155; color: #94a3b8; text-align: center; }
  .services-grid { align-items: start; }
  @media (max-width: 960px) {
    .grid--2, .provider-layout { grid-template-columns: 1fr; }
  }
  @media (max-width: 767px) {
    .hero-card { padding: 24px; }
    .search-row { flex-direction: column; }
    .tx-table { min-width: 560px; }
  }
`;

function renderWalletPage(): string {
  return `
    <section class="page-header">
      <div class="page-header__content">
        <h1>Wallet</h1>
        <p>Inspect the active wallet, balance, and cumulative spending tracked by the daemon.</p>
      </div>
    </section>
    <section class="card stack">
      <div id="loading" class="empty-state">Loading wallet details…</div>
      <div id="content" hidden>
        <div class="stat-list">
          <div class="stat"><span class="stat-label">Address</span><span class="stat-value mono" id="address"></span></div>
          <div class="stat"><span class="stat-label">DID</span><span class="stat-value mono" id="did"></span></div>
          <div class="stat"><span class="stat-label">Balance</span><span class="stat-value" id="balance"></span></div>
          <div class="stat"><span class="stat-label">Spent today</span><span class="stat-value" id="spent-day"></span></div>
          <div class="stat"><span class="stat-label">Spent this hour</span><span class="stat-value" id="spent-hour"></span></div>
          <div class="stat"><span class="stat-label">Spent this month</span><span class="stat-value" id="spent-month"></span></div>
          <div class="stat"><span class="stat-label">Daily limit</span><span class="stat-value" id="limit"></span></div>
        </div>
        <div class="top-actions" id="wallet-actions" hidden>
          <button class="button button--secondary" id="copy-address">📋 Copy Address</button>
          <a class="button button--secondary" id="explorer-link" target="_blank" rel="noopener" hidden>🔗 View on Explorer</a>
          <button class="button button--secondary" id="request-faucet" hidden>💧 Request Faucet</button>
        </div>
        <div class="notice notice--success" id="wallet-notice" hidden></div>
      </div>
    </section>
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

          const actions = document.getElementById('wallet-actions');
          actions.hidden = false;

          // Copy address
          document.getElementById('copy-address').addEventListener('click', () => {
            navigator.clipboard.writeText(data.address || '').then(() => {
              const notice = document.getElementById('wallet-notice');
              notice.textContent = 'Address copied to clipboard.';
              notice.hidden = false;
              setTimeout(() => { notice.hidden = true; }, 2000);
            });
          });

          // Explorer link
          if (data.explorerUrl && data.address) {
            const link = document.getElementById('explorer-link');
            link.href = data.explorerUrl + '/account/' + data.address;
            link.hidden = false;
          }

          // Faucet button
          if (data.faucetUrl && data.address) {
            const faucetBtn = document.getElementById('request-faucet');
            faucetBtn.hidden = false;
            faucetBtn.addEventListener('click', async () => {
              faucetBtn.disabled = true;
              faucetBtn.textContent = '💧 Requesting…';
              try {
                const faucetRes = await fetch(data.faucetUrl + '/gas', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ FixedAmountRequest: { recipient: data.address } }),
                });
                if (faucetRes.ok) {
                  const notice = document.getElementById('wallet-notice');
                  notice.textContent = 'Faucet tokens requested successfully. Balance will update shortly.';
                  notice.hidden = false;
                } else {
                  throw new Error('Faucet returned ' + faucetRes.status);
                }
              } catch (err) {
                const notice = document.getElementById('wallet-notice');
                notice.textContent = 'Faucet request failed: ' + (err.message || 'Unknown error');
                notice.className = 'notice notice--error';
                notice.hidden = false;
              }
              faucetBtn.disabled = false;
              faucetBtn.textContent = '💧 Request Faucet';
            });
          }
        } catch (e) {
          document.getElementById('loading').textContent = 'Failed to load wallet data.';
        }
      })();
    </script>`;
}

function renderDiscoverPage(): string {
  return `
    <section class="page-header">
      <div class="page-header__content">
        <h1>Discover agents</h1>
        <p>Search the registry for providers by capability and inspect their advertised pricing.</p>
      </div>
    </section>
    <section class="card stack">
      <div class="search-row">
        <input id="capability" type="text" placeholder="Enter capability name…" />
        <button class="button" id="search">Search</button>
      </div>
      <div id="results"></div>
    </section>
    <script>
      const input = document.getElementById('capability');
      const btn = document.getElementById('search');
      const results = document.getElementById('results');

      async function doSearch() {
        const cap = input.value.trim();
        if (!cap) return;
        btn.disabled = true;
        results.innerHTML = '<div class="empty-state">Searching the registry…</div>';
        try {
          const res = await fetch('/api/discover?capability=' + encodeURIComponent(cap));
          const data = await res.json();
          if (data.error) {
            results.innerHTML = '<div class="notice notice--error">' + esc(data.error) + '</div>';
            return;
          }
          if (!data.agents || data.agents.length === 0) {
            results.innerHTML = '<div class="empty-state">No agents found for this capability.</div>';
            return;
          }
          results.innerHTML = '<div class="agent-grid">' + data.agents.map((agent) => {
            const caps = (agent.capabilities || []).map((capability) => {
              return '<span class="tag">' + esc(capability.name) + ' · ' + esc(capability.priceMist) + ' ' + esc(capability.currency || 'USDC') + '</span>';
            }).join('');
            const detailRows = [
              '<div class="stat"><span class="stat-label">DID</span><span class="stat-value mono">' + esc(agent.did) + '</span></div>',
              agent.endpoint ? '<div class="stat"><span class="stat-label">Endpoint</span><span class="stat-value mono">' + esc(agent.endpoint) + '</span></div>' : '',
              '<div class="stat"><span class="stat-label">Status</span><span class="stat-value">' + (agent.active ? 'Active' : 'Inactive') + '</span></div>',
            ].filter(Boolean).join('');
            return '<article class="agent-card">' +
              '<div class="agent-name">' + esc(agent.name) + (agent.active ? '<span class="pill pill--success">Active</span>' : '<span class="pill pill--danger">Inactive</span>') + '</div>' +
              (caps ? '<div class="tag-list">' + caps + '</div>' : '') +
              '<details class="agent-details"><summary>Details</summary><div class="stat-list">' + detailRows + '</div></details>' +
              (agent.active ? '<div class="top-actions"><button class="button button--secondary execute-btn" data-did="' + esc(agent.did) + '" data-cap="' + esc((agent.capabilities?.[0]?.name) || '') + '">▶ Execute</button></div>' : '') +
              '</article>';
          }).join('') + '</div>';

          // Wire execute buttons
          results.querySelectorAll('.execute-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const did = btn.dataset.did;
              const cap = btn.dataset.cap;
              const cmd = 'collective_execute --provider ' + did + ' --capability ' + cap + ' --input "<your input>"';
              navigator.clipboard.writeText(cmd).then(() => {
                btn.textContent = '✓ Copied MCP command';
                setTimeout(() => { btn.textContent = '▶ Execute'; }, 2000);
              });
            });
          });
        } catch (e) {
          results.innerHTML = '<div class="notice notice--error">Search failed.</div>';
        } finally {
          btn.disabled = false;
        }
      }

      btn.addEventListener('click', doSearch);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doSearch();
      });

      function esc(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
      }
    </script>`;
}

function renderTasksPage(): string {
  return `
    <section class="page-header">
      <div class="page-header__content">
        <h1>Tasks &amp; spending</h1>
        <p>Review spend over time, provider status, and the latest metered task activity.</p>
      </div>
    </section>
    <section class="card stack">
      <div id="loading" class="empty-state">Loading task activity…</div>
      <div id="content" hidden>
        <div class="stat-list">
          <div class="stat"><span class="stat-label">Spent this hour</span><span class="stat-value" id="hour"></span></div>
          <div class="stat"><span class="stat-label">Spent today</span><span class="stat-value" id="day"></span></div>
          <div class="stat"><span class="stat-label">Spent this month</span><span class="stat-value" id="month"></span></div>
          <div class="stat"><span class="stat-label">Daily limit</span><span class="stat-value" id="limit"></span></div>
          <div class="stat"><span class="stat-label">Provider running</span><span class="stat-value" id="provider"></span></div>
        </div>
        <div class="section-header section-header--compact">
          <div>
            <h2>Recent transactions</h2>
            <p>Most recent metered task entries captured by the daemon.</p>
          </div>
        </div>
        <div id="entries"></div>
      </div>
    </section>
    <script>
      function esc(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
      }
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
            document.getElementById('entries').innerHTML = '<div class="empty-state">No transactions yet.</div>';
          } else {
            const rows = entries.map((entry) => {
              const details = [
                entry.taskId ? '<div class="stat"><span class="stat-label">Task ID</span><span class="stat-value mono">' + esc(entry.taskId) + '</span></div>' : '',
                entry.appId ? '<div class="stat"><span class="stat-label">App</span><span class="stat-value">' + esc(entry.appId) + '</span></div>' : '',
                entry.capability ? '<div class="stat"><span class="stat-label">Capability</span><span class="stat-value">' + esc(entry.capability) + '</span></div>' : '',
                entry.status ? '<div class="stat"><span class="stat-label">Status</span><span class="stat-value">' + esc(entry.status) + '</span></div>' : '',
              ].filter(Boolean).join('');
              return '<tr>' +
                '<td>' + esc(new Date(entry.timestamp).toLocaleString()) + '</td>' +
                '<td>' + esc(entry.amountSui) + ' SUI</td>' +
                '<td>' + esc(entry.rail) + '</td>' +
                '<td>' + esc(entry.taskId ?? '—') + '</td>' +
                '<td>' + esc(entry.appId ?? '—') + '</td>' +
                '</tr>' +
                (details ? '<tr class="detail-row"><td colspan="5"><details><summary>Details</summary><div class="stat-list">' + details + '</div></details></td></tr>' : '');
            }).join('');
            document.getElementById('entries').innerHTML = '<div class="table-wrap"><table class="tx-table"><thead><tr><th>Time</th><th>Amount</th><th>Rail</th><th>Task</th><th>App</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
          }

          document.getElementById('loading').hidden = true;
          document.getElementById('content').hidden = false;
        } catch (e) {
          document.getElementById('loading').textContent = 'Failed to load task data.';
        }
      })();
    </script>`;
}

function renderServicesPage(): string {
  return `
    <section class="page-header">
      <div class="page-header__content">
        <h1>Provider services</h1>
        <p>Manage local provider settings, advertised capabilities, registration status, and active client connections.</p>
      </div>
    </section>
    <section class="card stack">
      <div class="section-header">
        <div>
          <h2>Provider configuration</h2>
          <p>Enable provider mode, control registration defaults, and edit the capabilities exposed by this daemon.</p>
        </div>
        <div class="top-actions">
          <button class="button button--secondary" id="reload-provider">Reload</button>
          <button class="button" id="save-provider">Save configuration</button>
        </div>
      </div>
      <div id="provider-notice" class="notice" hidden></div>
      <div id="provider-loading" class="empty-state">Loading provider configuration…</div>
      <div id="provider-config" class="stack" hidden>
        <div class="grid grid--2">
          <div class="switch-row">
            <div class="switch-row__copy">
              <strong>Provider enabled</strong>
              <p>Accept work as a provider when the daemon runtime is started.</p>
            </div>
            <label class="switch" aria-label="Provider enabled">
              <input type="checkbox" id="provider-enabled" />
              <span class="switch__slider"></span>
            </label>
          </div>
          <div class="switch-row">
            <div class="switch-row__copy">
              <strong>Auto-register</strong>
              <p>Automatically publish or refresh your provider card when the runtime starts.</p>
            </div>
            <label class="switch" aria-label="Auto-register">
              <input type="checkbox" id="provider-auto-register" />
              <span class="switch__slider"></span>
            </label>
          </div>
        </div>
        <div class="grid grid--2">
          <label for="provider-max-concurrency">
            Max concurrency
            <span class="field-hint">How many provider tasks can run at the same time.</span>
            <input id="provider-max-concurrency" type="number" min="1" step="1" value="1" />
          </label>
          <div class="notice notice--warning">
            Subprocess adapters are disabled unless you explicitly acknowledge command execution in the capability editor.
          </div>
        </div>
        <div class="provider-layout">
          <div class="section">
            <div class="section-header section-header--compact">
              <div>
                <h3>Capabilities</h3>
                <p id="capability-summary">0 configured</p>
              </div>
              <button class="button button--secondary" id="new-capability">Add capability</button>
            </div>
            <div id="capability-list" class="capability-list"></div>
          </div>
          <div class="surface capability-card">
            <div class="section-header section-header--compact">
              <div>
                <h3 id="capability-editor-title">Add capability</h3>
                <p>Create or update a provider capability before saving the full configuration.</p>
              </div>
            </div>
            <div class="grid grid--2">
              <label for="capability-name">
                Name
                <input id="capability-name" type="text" placeholder="summarize" />
              </label>
              <label for="capability-version">
                Version
                <input id="capability-version" type="text" placeholder="1.0.0" />
              </label>
            </div>
            <label for="capability-description">
              Description
              <textarea id="capability-description" placeholder="Explain what this capability does for requesters."></textarea>
            </label>
            <div class="grid grid--2">
              <label for="capability-price-mist" id="capability-price-label">
                Price
                <input id="capability-price-mist" type="number" min="1" step="1" placeholder="1000" />
              </label>
              <label for="capability-currency">
                Currency
                <select id="capability-currency">
                  <option value="USDC" selected>USDC</option>
                  <option value="SUI">SUI</option>
                  <option value="MIST">MIST</option>
                </select>
              </label>
            </div>
            <label for="capability-adapter">
              Adapter type
              <select id="capability-adapter">
                <option value="job-queue" selected>job-queue</option>
                <option value="echo">echo</option>
                <option value="webhook">webhook</option>
                <option value="subprocess">subprocess</option>
                <option value="mcp-sampling">mcp-sampling</option>
              </select>
            </label>
            <div id="adapter-fields" class="grid"></div>
            <label for="capability-extra-config">
              Additional adapter config (JSON)
              <span class="field-hint">Optional extra fields. Webhook: headers, timeoutMs. Subprocess: env, cwd. MCP-sampling: maxTokens, modelHint. Job-queue: timeoutMs.</span>
              <textarea id="capability-extra-config" placeholder="{\n  \"timeoutMs\": 30000\n}"></textarea>
            </label>
            <div class="top-actions">
              <button class="button button--secondary" id="reset-capability">Clear</button>
              <button class="button" id="save-capability">Save capability</button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <div class="grid grid--2 services-grid">
      <section class="card stack">
        <div class="section-header section-header--compact">
          <div>
            <h2>On-chain registration</h2>
            <p>Current registry view for the active wallet.</p>
          </div>
        </div>
        <div id="registration" class="empty-state">Loading registry status…</div>
      </section>
      <section class="card stack">
        <div class="section-header section-header--compact">
          <div>
            <h2>Connected clients</h2>
            <p>Applications currently connected to the daemon over IPC.</p>
          </div>
        </div>
        <div id="clients" class="clients-list"></div>
      </section>
    </div>
    <script>
      const UI_ADAPTERS = ['job-queue', 'echo', 'webhook', 'subprocess', 'mcp-sampling'];
      const REQUIRED_KEYS = {
        echo: [],
        webhook: ['url'],
        subprocess: ['command', 'allowSubprocess'],
        'mcp-sampling': ['appName', 'systemPrompt'],
        'job-queue': ['instructions'],
      };

      const els = {
        notice: document.getElementById('provider-notice'),
        loading: document.getElementById('provider-loading'),
        config: document.getElementById('provider-config'),
        enabled: document.getElementById('provider-enabled'),
        autoRegister: document.getElementById('provider-auto-register'),
        maxConcurrency: document.getElementById('provider-max-concurrency'),
        capabilitySummary: document.getElementById('capability-summary'),
        capabilityList: document.getElementById('capability-list'),
        capabilityEditorTitle: document.getElementById('capability-editor-title'),
        name: document.getElementById('capability-name'),
        description: document.getElementById('capability-description'),
        version: document.getElementById('capability-version'),
        priceMist: document.getElementById('capability-price-mist'),
        currency: document.getElementById('capability-currency'),
        adapter: document.getElementById('capability-adapter'),
        adapterFields: document.getElementById('adapter-fields'),
        extraConfig: document.getElementById('capability-extra-config'),
        saveProvider: document.getElementById('save-provider'),
        reloadProvider: document.getElementById('reload-provider'),
        newCapability: document.getElementById('new-capability'),
        saveCapability: document.getElementById('save-capability'),
        resetCapability: document.getElementById('reset-capability'),
        registration: document.getElementById('registration'),
        clients: document.getElementById('clients'),
      };

      let providerConfig = { enabled: false, autoRegister: false, maxConcurrency: 1, capabilities: [] };
      let editingIndex = null;

      function esc(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
      }

      function showNotice(message, tone) {
        if (!message) {
          els.notice.hidden = true;
          els.notice.textContent = '';
          els.notice.className = 'notice';
          return;
        }
        els.notice.hidden = false;
        els.notice.textContent = message;
        els.notice.className = 'notice notice--' + tone;
      }

      function createEmptyProviderConfig() {
        return { enabled: false, autoRegister: false, maxConcurrency: 1, capabilities: [] };
      }

      function defaultCapability() {
        return {
          name: '',
          description: '',
          version: '1.0.0',
          priceMist: 1,
          currency: 'USDC',
          adapter: 'job-queue',
          adapterConfig: {},
        };
      }

      function normalizeCapability(capability) {
        const adapter = UI_ADAPTERS.includes(capability?.adapter) ? capability.adapter : 'job-queue';
        const adapterConfig = capability && capability.adapterConfig && typeof capability.adapterConfig === 'object' && !Array.isArray(capability.adapterConfig)
          ? { ...capability.adapterConfig }
          : {};
        return {
          name: typeof capability?.name === 'string' ? capability.name : '',
          description: typeof capability?.description === 'string' ? capability.description : '',
          version: typeof capability?.version === 'string' ? capability.version : '1.0.0',
          priceMist: Number.isInteger(capability?.priceMist) && capability.priceMist > 0 ? capability.priceMist : 1,
          currency: typeof capability?.currency === 'string' && capability.currency ? capability.currency : 'USDC',
          adapter,
          adapterConfig,
        };
      }

      function normalizeProviderConfig(data) {
        return {
          enabled: data?.enabled === true,
          autoRegister: data?.autoRegister === true,
          maxConcurrency: Number.isInteger(data?.maxConcurrency) && data.maxConcurrency > 0 ? data.maxConcurrency : 1,
          capabilities: Array.isArray(data?.capabilities) ? data.capabilities.map(normalizeCapability) : [],
        };
      }

      function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function getVisibleExtraConfig(capability) {
        const config = capability?.adapterConfig && typeof capability.adapterConfig === 'object' ? capability.adapterConfig : {};
        const hiddenKeys = new Set(REQUIRED_KEYS[capability?.adapter] || []);
        const extra = {};
        Object.keys(config).forEach((key) => {
          if (!hiddenKeys.has(key)) {
            extra[key] = config[key];
          }
        });
        return extra;
      }

      function describeAdapterConfig(capability) {
        const config = capability.adapterConfig || {};
        if (capability.adapter === 'webhook' && typeof config.url === 'string') return config.url;
        if (capability.adapter === 'subprocess' && typeof config.command === 'string') return config.command;
        if (capability.adapter === 'mcp-sampling' && typeof config.appName === 'string') return config.appName;
        if (capability.adapter === 'job-queue') return config.instructions ? 'Instructions configured' : 'Job queue (no instructions)';
        return 'No additional adapter config';
      }

      function renderCapabilityList() {
        els.capabilitySummary.textContent = providerConfig.capabilities.length + ' configured';
        if (providerConfig.capabilities.length === 0) {
          els.capabilityList.innerHTML = '<div class="empty-state">No capabilities configured yet. Add one to describe the services offered by this daemon.</div>';
          return;
        }

        els.capabilityList.innerHTML = providerConfig.capabilities.map((capability, index) => {
          const description = capability.description ? '<div class="capability-card__description">' + esc(capability.description) + '</div>' : '';
          return '<article class="surface surface--muted capability-card">' +
            '<div class="capability-card__title">' +
              '<div>' +
                '<div class="agent-name">' + esc(capability.name) + '</div>' +
                description +
              '</div>' +
              '<div class="capability-card__meta">' +
                '<span class="pill">v' + esc(capability.version) + '</span>' +
                '<span class="pill pill--accent">' + esc(capability.adapter) + '</span>' +
                '<span class="pill">' + esc(String(capability.priceMist)) + ' ' + esc(capability.currency || 'MIST') + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="client-meta mono">' + esc(describeAdapterConfig(capability)) + '</div>' +
            '<div class="top-actions">' +
              '<button class="button button--secondary" type="button" data-action="edit" data-index="' + esc(String(index)) + '">Edit</button>' +
              '<button class="button button--danger" type="button" data-action="delete" data-index="' + esc(String(index)) + '">Delete</button>' +
            '</div>' +
          '</article>';
        }).join('');
      }

      function setCapabilityEditor(capability, index) {
        editingIndex = typeof index === 'number' ? index : null;
        const next = normalizeCapability(capability || defaultCapability());
        els.capabilityEditorTitle.textContent = editingIndex === null ? 'Add capability' : 'Edit capability';
        els.name.value = next.name;
        els.description.value = next.description;
        els.version.value = next.version;
        els.priceMist.value = String(next.priceMist);
        els.currency.value = next.currency || 'USDC';
        els.adapter.value = next.adapter;
        els.extraConfig.value = Object.keys(getVisibleExtraConfig(next)).length > 0 ? JSON.stringify(getVisibleExtraConfig(next), null, 2) : '';
        renderAdapterFields(next);
      }

      function resetCapabilityEditor() {
        setCapabilityEditor(defaultCapability(), null);
      }

      function renderAdapterFields(capability) {
        const config = capability?.adapterConfig && typeof capability.adapterConfig === 'object' ? capability.adapterConfig : {};
        if (capability.adapter === 'echo') {
          els.adapterFields.innerHTML = '<div class="notice">Echo requires no adapter config. It returns the request payload as-is.</div>';
          return;
        }
        if (capability.adapter === 'webhook') {
          els.adapterFields.innerHTML = '<label for="adapter-webhook-url">Webhook URL<input id="adapter-webhook-url" data-field="url" type="url" placeholder="https://example.com/webhook" value="' + esc(config.url || '') + '" /></label>';
          return;
        }
        if (capability.adapter === 'subprocess') {
          const checked = config.allowSubprocess === true ? ' checked' : '';
          els.adapterFields.innerHTML = '<label for="adapter-subprocess-command">Command<input id="adapter-subprocess-command" data-field="command" type="text" placeholder="python worker.py" value="' + esc(config.command || '') + '" /></label>' +
            '<div class="notice notice--warning">Subprocess adapters can execute local commands. Save is blocked until you explicitly acknowledge this risk.</div>' +
            '<label class="switch-row" for="adapter-subprocess-allow"><span class="switch-row__copy"><strong>Allow subprocess execution</strong><p>I understand this capability can launch local commands.</p></span><span><input id="adapter-subprocess-allow" data-field="allowSubprocess" type="checkbox"' + checked + ' /></span></label>';
          return;
        }
        if (capability.adapter === 'mcp-sampling') {
          els.adapterFields.innerHTML = '<label for="adapter-mcp-app-name">App name<input id="adapter-mcp-app-name" data-field="appName" type="text" placeholder="Portal Assistant" value="' + esc(config.appName || '') + '" /></label>' +
            '<label for="adapter-mcp-system-prompt">System prompt<textarea id="adapter-mcp-system-prompt" data-field="systemPrompt" placeholder="Describe the assistant behavior for the MCP sampling adapter.">' + esc(config.systemPrompt || '') + '</textarea></label>';
          return;
        }
        if (capability.adapter === 'job-queue') {
          els.adapterFields.innerHTML = '<label for="adapter-jobqueue-instructions">Instructions<textarea id="adapter-jobqueue-instructions" data-field="instructions" rows="4" placeholder="Describe how the agent should process incoming work items for this capability.">' + esc(config.instructions || '') + '</textarea></label>' +
            '<div class="notice">Work items arrive in a persistent queue. Your agent polls via the <code>collective_work_queue</code> tool, processes items according to these instructions, then marks them complete.</div>';
          return;
        }
      }

      function parseExtraConfig(lenient) {
        const raw = els.extraConfig.value.trim();
        if (!raw) {
          return {};
        }
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Additional adapter config must be a JSON object.');
          }
          return parsed;
        } catch (error) {
          if (lenient) {
            return {};
          }
          throw error instanceof Error ? error : new Error('Additional adapter config must be valid JSON.');
        }
      }

      function readCapabilityForm(lenient) {
        const adapter = els.adapter.value;
        const capability = {
          name: els.name.value.trim(),
          description: els.description.value.trim(),
          version: els.version.value.trim(),
          priceMist: Number.parseInt(els.priceMist.value || '0', 10),
          currency: els.currency.value.trim(),
          adapter,
          adapterConfig: parseExtraConfig(lenient),
        };

        if (adapter === 'webhook') {
          const url = (document.getElementById('adapter-webhook-url')?.value || '').trim();
          if (!lenient && !url) throw new Error('Webhook adapter requires a URL.');
          if (url) capability.adapterConfig.url = url;
        } else if (adapter === 'subprocess') {
          const command = (document.getElementById('adapter-subprocess-command')?.value || '').trim();
          const allowSubprocess = document.getElementById('adapter-subprocess-allow')?.checked === true;
          if (!lenient && !command) throw new Error('Subprocess adapter requires a command.');
          if (!lenient && !allowSubprocess) throw new Error('Subprocess adapter requires explicit acknowledgement before saving.');
          if (command) capability.adapterConfig.command = command;
          if (allowSubprocess) capability.adapterConfig.allowSubprocess = true;
        } else if (adapter === 'mcp-sampling') {
          const appName = (document.getElementById('adapter-mcp-app-name')?.value || '').trim();
          const systemPrompt = (document.getElementById('adapter-mcp-system-prompt')?.value || '').trim();
          if (!lenient && !appName) throw new Error('mcp-sampling adapter requires an app name.');
          if (!lenient && !systemPrompt) throw new Error('mcp-sampling adapter requires a system prompt.');
          if (appName) capability.adapterConfig.appName = appName;
          if (systemPrompt) capability.adapterConfig.systemPrompt = systemPrompt;
        } else if (adapter === 'job-queue') {
          const instructions = (document.getElementById('adapter-jobqueue-instructions')?.value || '').trim();
          if (instructions) capability.adapterConfig.instructions = instructions;
        }

        if (adapter === 'echo' && Object.keys(capability.adapterConfig).length === 0) {
          capability.adapterConfig = undefined;
        }

        return capability;
      }

      function validateCapability(capability) {
        if (!capability.name || !capability.description || !capability.version) {
          throw new Error('Capability name, description, and version are required.');
        }
        if (!Number.isInteger(capability.priceMist) || capability.priceMist <= 0) {
          throw new Error('Capability price must be a positive integer in MIST.');
        }
      }

      function collectProviderConfig() {
        return {
          enabled: els.enabled.checked,
          autoRegister: els.autoRegister.checked,
          maxConcurrency: Math.max(1, Number.parseInt(els.maxConcurrency.value || '1', 10) || 1),
          capabilities: providerConfig.capabilities.map((capability) => {
            const normalized = normalizeCapability(capability);
            return {
              name: normalized.name,
              description: normalized.description,
              version: normalized.version,
              priceMist: normalized.priceMist,
              currency: normalized.currency || undefined,
              adapter: normalized.adapter,
              adapterConfig: normalized.adapterConfig && Object.keys(normalized.adapterConfig).length > 0 ? cloneJson(normalized.adapterConfig) : undefined,
            };
          }),
        };
      }

      async function loadProviderConfig() {
        els.loading.hidden = false;
        els.config.hidden = true;
        showNotice('', 'success');
        try {
          const res = await fetch('/api/provider/config');
          const data = await res.json();
          if (!res.ok) {
            throw new Error(typeof data.error === 'string' ? data.error : 'Unable to load provider configuration.');
          }
          providerConfig = normalizeProviderConfig(data || createEmptyProviderConfig());
          els.enabled.checked = providerConfig.enabled;
          els.autoRegister.checked = providerConfig.autoRegister;
          els.maxConcurrency.value = String(providerConfig.maxConcurrency || 1);
          renderCapabilityList();
          resetCapabilityEditor();
          els.loading.hidden = true;
          els.config.hidden = false;
        } catch (error) {
          els.loading.textContent = 'Failed to load provider configuration.';
          showNotice(error instanceof Error ? error.message : 'Failed to load provider configuration.', 'error');
        }
      }

      async function saveProviderConfig() {
        els.saveProvider.disabled = true;
        showNotice('', 'success');
        try {
          const payload = collectProviderConfig();
          const res = await fetch('/api/provider/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(typeof data.error === 'string' ? data.error : 'Unable to save provider settings.');
          }
          await loadProviderConfig();
          await loadRegistration();
          showNotice('Provider configuration saved successfully.', 'success');
        } catch (error) {
          showNotice(error instanceof Error ? error.message : 'Unable to save provider settings.', 'error');
        } finally {
          els.saveProvider.disabled = false;
        }
      }

      async function loadRegistration() {
        try {
          const res = await fetch('/api/services');
          const data = await res.json();
          if (data.error) {
            els.registration.innerHTML = '<div class="notice notice--error">' + esc(data.error) + '</div>' +
              '<div class="top-actions"><button class="button button--secondary" id="refresh-reg">🔄 Refresh</button></div>';
            document.getElementById('refresh-reg')?.addEventListener('click', loadRegistration);
            return;
          }
          const actionButtons = '<div class="top-actions">' +
            '<button class="button button--secondary" id="refresh-reg">🔄 Refresh</button>' +
            (data.registered
              ? '<button class="button button--danger" id="unregister-btn">Unregister</button>'
              : '<button class="button" id="register-btn">Register now</button>') +
            '</div>';
          if (!data.registered) {
            els.registration.innerHTML = '<div class="empty-state">No agent is registered on-chain for this wallet yet.</div>' + actionButtons;
          } else {
            const agent = data.agent;
            const capabilities = (agent.capabilities || []).map((capability) => {
              return '<span class="tag">' + esc(capability.name) + ' · ' + esc(capability.priceMist) + ' ' + esc(capability.currency || 'USDC') + '</span>';
            }).join('');
            els.registration.innerHTML = '<div class="stat-list">' +
              '<div class="stat"><span class="stat-label">Name</span><span class="stat-value">' + esc(agent.name) + ' ' + (agent.active ? '<span class="pill pill--success">Active</span>' : '<span class="pill pill--danger">Inactive</span>') + '</span></div>' +
              '<div class="stat"><span class="stat-label">DID</span><span class="stat-value mono">' + esc(agent.did) + '</span></div>' +
              (agent.endpoint ? '<div class="stat"><span class="stat-label">Endpoint</span><span class="stat-value mono">' + esc(agent.endpoint) + '</span></div>' : '') +
              (agent.payoutAddress ? '<div class="stat"><span class="stat-label">Payout address</span><span class="stat-value mono">' + esc(agent.payoutAddress) + '</span></div>' : '') +
              '</div>' +
              (capabilities ? '<div class="tag-list">' + capabilities + '</div>' : '<div class="empty-state">No capabilities are currently registered on-chain.</div>') +
              actionButtons;
          }
          document.getElementById('refresh-reg')?.addEventListener('click', loadRegistration);
          document.getElementById('register-btn')?.addEventListener('click', async () => {
            if (!confirm('Register your provider on-chain? This will submit a transaction.')) return;
            const btn = document.getElementById('register-btn');
            btn.disabled = true; btn.textContent = 'Registering…';
            try {
              const r = await fetch('/api/provider/register', { method: 'POST' });
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              await loadRegistration();
            } catch (e) { alert('Registration failed: ' + e.message); btn.disabled = false; btn.textContent = 'Register now'; }
          });
          document.getElementById('unregister-btn')?.addEventListener('click', async () => {
            if (!confirm('Unregister from the on-chain registry? You can re-register later.')) return;
            const btn = document.getElementById('unregister-btn');
            btn.disabled = true; btn.textContent = 'Unregistering…';
            try {
              const r = await fetch('/api/provider/unregister', { method: 'POST' });
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              await loadRegistration();
            } catch (e) { alert('Unregister failed: ' + e.message); btn.disabled = false; btn.textContent = 'Unregister'; }
          });
        } catch (error) {
          els.registration.innerHTML = '<div class="notice notice--error">Failed to load registry data.</div>' +
            '<div class="top-actions"><button class="button button--secondary" id="refresh-reg">🔄 Refresh</button></div>';
          document.getElementById('refresh-reg')?.addEventListener('click', loadRegistration);
        }
      }

      async function loadClients() {
        try {
          const res = await fetch('/api/clients');
          const data = await res.json();
          const clients = data.clients || [];
          if (clients.length === 0) {
            els.clients.innerHTML = '<div class="empty-state">No clients connected.</div>';
            return;
          }
          els.clients.innerHTML = clients.map((client) => {
            return '<div class="client-row">' +
              '<div><div class="client-name">' + esc(client.appName) + '</div>' +
              (client.profile ? '<div class="client-meta">Profile: ' + esc(client.profile) + '</div>' : '') +
              '<div class="client-meta">PID ' + esc(String(client.pid)) + ' · Connected ' + esc(client.connectedAgo) + '</div>' +
              '</div>' +
              '<button class="button button--secondary button--small disconnect-btn" data-pid="' + client.pid + '">Disconnect</button>' +
            '</div>';
          }).join('');
          els.clients.querySelectorAll('.disconnect-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
              if (!confirm('Disconnect this client? It will need to reconnect.')) return;
              btn.disabled = true;
              try {
                await fetch('/api/clients/' + btn.dataset.pid, { method: 'DELETE' });
                await loadClients();
              } catch (e) { btn.disabled = false; }
            });
          });
        } catch (error) {
          els.clients.innerHTML = '<div class="notice notice--error">Failed to load client data.</div>';
        }
      }

      els.reloadProvider.addEventListener('click', loadProviderConfig);
      els.saveProvider.addEventListener('click', saveProviderConfig);
      els.newCapability.addEventListener('click', () => {
        resetCapabilityEditor();
        els.name.focus();
      });
      els.resetCapability.addEventListener('click', resetCapabilityEditor);
      els.adapter.addEventListener('change', () => {
        const draft = readCapabilityForm(true);
        draft.adapter = els.adapter.value;
        draft.adapterConfig = {};
        renderAdapterFields(draft);
      });
      els.saveCapability.addEventListener('click', () => {
        try {
          const capability = readCapabilityForm(false);
          validateCapability(capability);
          if (editingIndex === null) {
            providerConfig.capabilities.push(capability);
          } else {
            providerConfig.capabilities[editingIndex] = capability;
          }
          renderCapabilityList();
          resetCapabilityEditor();
          showNotice('Capability saved locally. Save configuration to persist the changes.', 'success');
        } catch (error) {
          showNotice(error instanceof Error ? error.message : 'Unable to save capability.', 'error');
        }
      });
      els.capabilityList.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!target) return;
        const index = Number.parseInt(target.dataset.index || '', 10);
        if (!Number.isInteger(index) || index < 0 || index >= providerConfig.capabilities.length) {
          return;
        }
        if (target.dataset.action === 'edit') {
          setCapabilityEditor(providerConfig.capabilities[index], index);
          els.name.focus();
          return;
        }
        if (target.dataset.action === 'delete') {
          const capName = providerConfig.capabilities[index]?.name || 'this capability';
          if (!confirm('Delete "' + capName + '"? This is not persisted until you save.')) return;
          providerConfig.capabilities.splice(index, 1);
          renderCapabilityList();
          if (editingIndex === index) {
            resetCapabilityEditor();
          }
          showNotice('Capability removed locally. Save configuration to persist the change.', 'success');
        }
      });

      Promise.all([loadProviderConfig(), loadRegistration(), loadClients()]).catch(() => undefined);
    </script>`;
}

function renderQueuePage(): string {
  return `
    <style>
      ${INNER_PAGE_STYLES}
      .queue-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
      .queue-tabs button { padding: 6px 14px; border-radius: 6px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; font-size: 13px; transition: all 0.15s; }
      .queue-tabs button.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
      .queue-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .queue-table th { text-align: left; padding: 10px 12px; color: #94a3b8; border-bottom: 1px solid #1e293b; font-weight: 500; }
      .queue-table td { padding: 10px 12px; border-bottom: 1px solid #1e293b; color: #e2e8f0; vertical-align: top; }
      .queue-table tr:hover td { background: #1e293b; }
      .queue-table .mono { font-family: monospace; font-size: 12px; color: #94a3b8; }
      .queue-table .preview { max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
      .status-badge--pending { background: #422006; color: #fbbf24; }
      .status-badge--claimed { background: #172554; color: #60a5fa; }
      .status-badge--completed { background: #052e16; color: #4ade80; }
      .status-badge--failed { background: #450a0a; color: #f87171; }
      .queue-actions { display: flex; gap: 6px; }
      .queue-actions button { padding: 4px 10px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer; }
      .queue-actions .btn-retry { background: #1e40af; color: #fff; }
      .queue-actions .btn-retry:hover { background: #2563eb; }
      .queue-actions .btn-delete { background: #7f1d1d; color: #fff; }
      .queue-actions .btn-delete:hover { background: #991b1b; }
      .empty-queue { text-align: center; padding: 48px 16px; color: #64748b; }
      .queue-count { color: #64748b; font-size: 13px; }
      .detail-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
      .detail-modal__content { background: #1e293b; border-radius: 12px; padding: 24px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
      .detail-modal__content h3 { margin: 0 0 12px; color: #f1f5f9; }
      .detail-modal__content pre { background: #0f172a; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #94a3b8; white-space: pre-wrap; word-break: break-all; }
      .detail-modal__close { float: right; background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; }
    </style>

    <div class="page-header">
      <div class="page-header__content">
        <div class="title-row">
          <h1>Work Queue</h1>
          <span class="queue-count" id="queue-count"></span>
        </div>
        <p class="text-muted">Incoming tasks waiting to be processed by your agent.</p>
      </div>
    </div>

    <div class="stack">
      <div class="queue-tabs" id="queue-tabs">
        <button class="active" data-status="">All</button>
        <button data-status="pending">Pending</button>
        <button data-status="claimed">Claimed</button>
        <button data-status="completed">Completed</button>
        <button data-status="failed">Failed</button>
      </div>

      <div id="queue-content">
        <div class="empty-queue">Loading...</div>
      </div>
    </div>

    <div id="detail-modal" style="display:none"></div>

    <script>
      (function() {
        let currentFilter = '';
        let refreshTimer;

        const content = document.getElementById('queue-content');
        const countEl = document.getElementById('queue-count');
        const tabs = document.getElementById('queue-tabs');
        const modal = document.getElementById('detail-modal');

        function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

        function formatTime(ts) {
          if (!ts) return '—';
          const d = new Date(ts);
          return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
        }

        async function loadQueue() {
          try {
            const url = currentFilter ? '/api/work-queue?status=' + encodeURIComponent(currentFilter) : '/api/work-queue';
            const res = await fetch(url);
            const data = await res.json();
            renderQueue(data.items || [], data.count || 0);
          } catch (err) {
            content.innerHTML = '<div class="empty-queue">Failed to load queue.</div>';
          }
        }

        function renderQueue(items, count) {
          countEl.textContent = count + ' item' + (count === 1 ? '' : 's');
          if (items.length === 0) {
            content.innerHTML = '<div class="empty-queue">No work items' + (currentFilter ? ' with status "' + esc(currentFilter) + '"' : '') + '.</div>';
            return;
          }

          let html = '<table class="queue-table"><thead><tr><th>Status</th><th>Capability</th><th>Input</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
          for (const item of items) {
            html += '<tr>' +
              '<td><span class="status-badge status-badge--' + esc(item.status) + '">' + esc(item.status) + '</span></td>' +
              '<td>' + esc(item.capability) + '</td>' +
              '<td class="preview mono" title="' + esc(item.inputData || '') + '">' + esc((item.inputData || '').slice(0, 80)) + '</td>' +
              '<td class="mono">' + formatTime(item.createdAt) + '</td>' +
              '<td class="queue-actions">' +
                '<button class="btn-retry" data-action="view" data-id="' + esc(item.id) + '">View</button>' +
                (item.status === 'failed' || item.status === 'claimed' ? '<button class="btn-retry" data-action="retry" data-id="' + esc(item.id) + '">Retry</button>' : '') +
                '<button class="btn-delete" data-action="delete" data-id="' + esc(item.id) + '">Delete</button>' +
              '</td>' +
            '</tr>';
          }
          html += '</tbody></table>';
          content.innerHTML = html;
        }

        tabs.addEventListener('click', (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          tabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentFilter = btn.dataset.status || '';
          loadQueue();
        });

        content.addEventListener('click', async (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          const action = btn.dataset.action;
          const id = btn.dataset.id;
          if (!action || !id) return;

          if (action === 'retry') {
            if (!confirm('Retry this work item? It will be re-queued as pending.')) return;
            await fetch('/api/work-queue/' + encodeURIComponent(id) + '/retry', { method: 'POST' });
            loadQueue();
          } else if (action === 'delete') {
            if (!confirm('Permanently delete this work item?')) return;
            await fetch('/api/work-queue/' + encodeURIComponent(id), { method: 'DELETE' });
            loadQueue();
          } else if (action === 'view') {
            showDetail(id);
          }
        });

        async function showDetail(id) {
          try {
            const res = await fetch('/api/work-queue?status=');
            const data = await res.json();
            const item = (data.items || []).find(i => i.id === id);
            if (!item) { modal.style.display = 'none'; return; }
            modal.style.display = 'flex';
            modal.innerHTML = '<div class="detail-modal__content">' +
              '<button class="detail-modal__close" id="close-modal">&times;</button>' +
              '<h3>Work Item</h3>' +
              '<p><strong>ID:</strong> <span class="mono">' + esc(item.id) + '</span></p>' +
              '<p><strong>Task ID:</strong> <span class="mono">' + esc(item.taskId) + '</span></p>' +
              '<p><strong>Capability:</strong> ' + esc(item.capability) + '</p>' +
              '<p><strong>Status:</strong> <span class="status-badge status-badge--' + esc(item.status) + '">' + esc(item.status) + '</span></p>' +
              '<p><strong>Created:</strong> ' + formatTime(item.createdAt) + '</p>' +
              (item.claimedAt ? '<p><strong>Claimed:</strong> ' + formatTime(item.claimedAt) + '</p>' : '') +
              (item.completedAt ? '<p><strong>Completed:</strong> ' + formatTime(item.completedAt) + '</p>' : '') +
              '<h4>Input</h4><pre>' + esc(item.inputData || '(empty)') + '</pre>' +
              (item.resultData ? '<h4>Result</h4><pre>' + esc(item.resultData) + '</pre>' : '') +
              (item.error ? '<h4>Error</h4><pre style="color:#f87171">' + esc(item.error) + '</pre>' : '') +
            '</div>';
            document.getElementById('close-modal').addEventListener('click', () => { modal.style.display = 'none'; });
          } catch (err) {
            modal.style.display = 'none';
          }
        }

        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.style.display = 'none';
        });

        loadQueue();
        refreshTimer = setInterval(loadQueue, 5000);
      })();
    </script>`;
}

function wrapInLayout(title: string, activeNav: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${BASE_STYLES}${INNER_PAGE_STYLES}</style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand__mark">⬢</span>
          <div class="brand__copy">
            <strong>HiveMind Collective</strong>
            <span>Local portal · 127.0.0.1</span>
          </div>
        </div>
        ${renderPortalNav(activeNav)}
      </aside>
      <main class="content">
        <div class="panel">
          ${bodyHtml}
        </div>
      </main>
    </div>
  </body>
</html>`;
}

function renderPortalNav(activeNav: string): string {
  return `<nav class="nav">${PORTAL_NAV.map((item) => {
    const activeClass = item.id === activeNav ? ' is-active' : '';
    const current = item.id === activeNav ? ' aria-current="page"' : '';
    return `<a class="nav__item${activeClass}" href="${item.href}"${current}><span class="nav__icon" aria-hidden="true">${item.icon}</span><span class="nav__label">${item.label}</span></a>`;
  }).join('')}</nav>`;
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

function snapshotPortalSettings(config: DaemonFullConfig): Pick<DaemonFullConfig, 'auth' | 'payment' | 'spending' | 'relay' | 'encryption'> {
  return structuredClone({
    auth: config.auth,
    payment: config.payment,
    spending: config.spending,
    relay: config.relay,
    encryption: config.encryption,
  });
}

function restorePortalSettings(
  target: DaemonFullConfig,
  snapshot: Pick<DaemonFullConfig, 'auth' | 'payment' | 'spending' | 'relay' | 'encryption'>,
): void {
  target.auth = snapshot.auth;
  target.payment = snapshot.payment;
  target.spending = snapshot.spending;
  target.relay = snapshot.relay;
  target.encryption = snapshot.encryption;
}

function getPortalFullSettings(config: DaemonFullConfig): PortalFullSettings {
  return {
    daemon: {
      logLevel: config.daemon.logLevel,
      dataDir: config.daemon.dataDir,
      pidFile: config.daemon.pidFile,
    },
    relay: {
      autoConnect: config.relay.autoConnect,
      providerMode: config.relay.providerMode,
      endpoints: config.relay.endpoints.map((endpoint) => endpoint.url),
    },
    encryption: {
      enabled: config.encryption.enabled,
      requireEncryption: config.encryption.requireEncryption,
    },
    spending: {
      allowedApps: [...(config.spending.allowlist ?? [])],
      deniedApps: [...(config.spending.denylist ?? [])],
    },
  };
}

function validatePortalSettingsInput(body: unknown, current: DaemonFullConfig): PortalSettingsUpdate {
  if (!isRecord(body)) {
    throw new PortalSettingsValidationError('Settings payload must be an object.');
  }

  let dailyLimitMist: bigint;
  try {
    dailyLimitMist = normalizeDailyLimit(body);
  } catch (error) {
    throw new PortalSettingsValidationError(getSafeErrorMessage(error, 'A daily spending limit is required.'));
  }

  const relay = isRecord(body.relay) ? body.relay : {};
  const autoConnect =
    relay.autoConnect === undefined
      ? current.relay.autoConnect
      : readOptionalBoolean(relay.autoConnect);
  if (autoConnect === undefined) {
    throw new PortalSettingsValidationError('relay.autoConnect must be a boolean.');
  }

  const providerMode =
    relay.providerMode === undefined
      ? current.relay.providerMode
      : readOptionalBoolean(relay.providerMode);
  if (providerMode === undefined) {
    throw new PortalSettingsValidationError('relay.providerMode must be a boolean.');
  }

  const endpoints =
    relay.endpoints === undefined
      ? current.relay.endpoints.map((endpoint) => ({ ...endpoint }))
      : normalizeRelayEndpoints(relay.endpoints, current.relay.endpoints);

  const encryption = isRecord(body.encryption) ? body.encryption : {};
  const encryptionEnabled =
    encryption.enabled === undefined
      ? current.encryption.enabled
      : readOptionalBoolean(encryption.enabled);
  if (encryptionEnabled === undefined) {
    throw new PortalSettingsValidationError('encryption.enabled must be a boolean.');
  }

  const requireEncryption =
    encryption.requireEncryption === undefined
      ? current.encryption.requireEncryption
      : readOptionalBoolean(encryption.requireEncryption);
  if (requireEncryption === undefined) {
    throw new PortalSettingsValidationError('encryption.requireEncryption must be a boolean.');
  }

  if (requireEncryption && !encryptionEnabled) {
    throw new PortalSettingsValidationError('Require encryption cannot be enabled when encryption is disabled.');
  }

  const spending = isRecord(body.spending) ? body.spending : {};

  return {
    dailyLimitMist,
    relay: {
      autoConnect,
      providerMode,
      endpoints,
    },
    encryption: {
      enabled: encryptionEnabled,
      requireEncryption,
    },
    spending: {
      allowlist:
        spending.allowedApps === undefined
          ? current.spending.allowlist
          : normalizeOptionalStringList(spending.allowedApps, 'spending.allowedApps'),
      denylist:
        spending.deniedApps === undefined
          ? current.spending.denylist
          : normalizeOptionalStringList(spending.deniedApps, 'spending.deniedApps'),
    },
  };
}

function normalizeRelayEndpoints(
  value: unknown,
  current: DaemonFullConfig['relay']['endpoints'],
): DaemonFullConfig['relay']['endpoints'] {
  const currentRelayDidByUrl = new Map(current.map((endpoint) => [endpoint.url, endpoint.relayDid]));

  return normalizeStringList(value, 'relay.endpoints').map((url, index) => {
    validateRelayEndpointUrl(url, index);
    const relayDid = currentRelayDidByUrl.get(url);
    return relayDid ? { url, relayDid } : { url };
  });
}

function normalizeOptionalStringList(value: unknown, field: string): string[] | undefined {
  const entries = normalizeStringList(value, field);
  return entries.length > 0 ? entries : undefined;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(value)) {
    throw new PortalSettingsValidationError(`${field} must be an array of strings.`);
  }

  return value
    .map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new PortalSettingsValidationError(`${field}[${index}] must be a string.`);
      }
      return entry.trim();
    })
    .filter(Boolean);
}

function validateRelayEndpointUrl(value: string, index: number): void {
  const label = `relay.endpoints[${index}]`;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new PortalSettingsValidationError(`${label} must use ws or wss protocol.`);
    }
  } catch (error) {
    if (error instanceof PortalSettingsValidationError) {
      throw error;
    }
    throw new PortalSettingsValidationError(`${label} is not a valid URL.`);
  }
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

function getProviderConfigForPortal(config: DaemonFullConfig): PortalProviderConfig {
  return {
    enabled: config.provider?.enabled ?? false,
    autoRegister: config.provider?.autoRegister ?? false,
    maxConcurrency: config.provider?.maxConcurrency ?? 1,
    capabilities: (config.provider?.capabilities ?? [])
      .filter((capability) => capability.adapter !== 'local-function')
      .map((capability) => ({
        name: capability.name,
        description: capability.description,
        version: capability.version,
        priceMist: capability.priceMist,
        currency: capability.currency,
        adapter: capability.adapter,
        adapterConfig: sanitizeJsonRecord(capability.adapterConfig),
      })),
  };
}

function sanitizeJsonRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function validateProviderConfigInput(body: unknown): PortalProviderConfig {
  if (!isRecord(body)) {
    throw new ProviderConfigValidationError('Provider config payload must be an object.');
  }

  if (typeof body.enabled !== 'boolean') {
    throw new ProviderConfigValidationError('enabled must be a boolean.');
  }

  if (!Array.isArray(body.capabilities)) {
    throw new ProviderConfigValidationError('capabilities must be an array.');
  }

  const autoRegister = readOptionalBoolean(body.autoRegister);
  if (body.autoRegister !== undefined && autoRegister === undefined) {
    throw new ProviderConfigValidationError('autoRegister must be a boolean when provided.');
  }

  const maxConcurrency = parseOptionalPositiveInteger(body.maxConcurrency, 'maxConcurrency');

  return {
    enabled: body.enabled,
    autoRegister,
    maxConcurrency,
    capabilities: body.capabilities.map((capability, index) => validateProviderCapabilityInput(capability, index)),
  };
}

function validateProviderCapabilityInput(value: unknown, index: number): PortalProviderCapability {
  if (!isRecord(value)) {
    throw new ProviderConfigValidationError(`capabilities[${index}] must be an object.`);
  }

  const name = requireNonEmptyString(value.name, `capabilities[${index}].name`);
  const description = requireNonEmptyString(value.description, `capabilities[${index}].description`);
  const version = requireNonEmptyString(value.version, `capabilities[${index}].version`);
  const priceMist = parsePositiveInteger(value.priceMist, `capabilities[${index}].priceMist`);
  const adapter = validateProviderAdapter(value.adapter, index);
  const currency = value.currency === undefined ? undefined : requireNonEmptyString(value.currency, `capabilities[${index}].currency`);
  const adapterConfig = validateProviderAdapterConfig(value.adapterConfig, adapter, index);

  return {
    name,
    description,
    version,
    priceMist,
    currency,
    adapter,
    adapterConfig,
  };
}

function validateProviderAdapter(value: unknown, index: number): PortalProviderCapability['adapter'] {
  const adapter = requireNonEmptyString(value, `capabilities[${index}].adapter`) as PortalProviderCapability['adapter'];
  if (!VALID_PROVIDER_ADAPTERS.has(adapter)) {
    throw new ProviderConfigValidationError(`capabilities[${index}].adapter must be one of: ${Array.from(VALID_PROVIDER_ADAPTERS).join(', ')}.`);
  }
  if (adapter === 'local-function') {
    throw new ProviderConfigValidationError('local-function adapters are programmatic only and cannot be configured from the portal.');
  }
  return adapter;
}

function validateProviderAdapterConfig(
  value: unknown,
  adapter: PortalProviderCapability['adapter'],
  index: number,
): Record<string, unknown> | undefined {
  if (value !== undefined && !isRecord(value)) {
    throw new ProviderConfigValidationError(`capabilities[${index}].adapterConfig must be an object when provided.`);
  }

  const adapterConfig = value ? { ...value } : {};

  switch (adapter) {
    case 'echo':
      return Object.keys(adapterConfig).length > 0 ? adapterConfig : undefined;
    case 'webhook': {
      const url = requireNonEmptyString(adapterConfig.url, `capabilities[${index}].adapterConfig.url`);
      validateHttpUrl(url, 'Webhook URL');
      return { ...adapterConfig, url };
    }
    case 'subprocess': {
      const command = requireNonEmptyString(adapterConfig.command, `capabilities[${index}].adapterConfig.command`);
      if (adapterConfig.allowSubprocess !== true) {
        throw new ProviderConfigValidationError('subprocess adapters require adapterConfig.allowSubprocess to be true.');
      }
      return { ...adapterConfig, command, allowSubprocess: true };
    }
    case 'mcp-sampling': {
      const appName = requireNonEmptyString(adapterConfig.appName, `capabilities[${index}].adapterConfig.appName`);
      const systemPrompt = requireNonEmptyString(adapterConfig.systemPrompt, `capabilities[${index}].adapterConfig.systemPrompt`);
      return { ...adapterConfig, appName, systemPrompt };
    }
    case 'job-queue':
      return Object.keys(adapterConfig).length > 0 ? adapterConfig : undefined;
    default:
      return Object.keys(adapterConfig).length > 0 ? adapterConfig : undefined;
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  throw new ProviderConfigValidationError(`${field} must be a non-empty string.`);
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim()) && Number(value.trim()) > 0) {
    return Number(value.trim());
  }
  throw new ProviderConfigValidationError(`${field} must be a positive integer.`);
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return parsePositiveInteger(value, field);
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isInputValidationError(error: unknown): boolean {
  return (
    error instanceof PortalSettingsValidationError ||
    (error instanceof Error &&
      /(dailyLimit|required|valid SUI amount|non-negative integer)/i.test(error.message))
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

const VALID_PROVIDER_ADAPTERS = new Set<PortalProviderCapability['adapter']>([
  'job-queue',
  'echo',
  'local-function',
  'webhook',
  'subprocess',
  'mcp-sampling',
]);

const BASE_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0a0f1a;
    --sidebar: #0f1628;
    --card: #111827;
    --surface: #0b1220;
    --border: #1e293b;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #3b82f6;
    --success: #10b981;
    --danger: #ef4444;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
  body { font-family: inherit; }
  a { color: inherit; }
  h1, h2, h3 { margin: 0; line-height: 1.2; }
  p { margin: 0; color: #cbd5e1; line-height: 1.65; }
  strong { color: var(--text); }
  label { display: grid; gap: 8px; color: var(--text); font-weight: 600; }
  input, textarea, select { width: 100%; border-radius: 12px; border: 1px solid #334155; background: #09101c; color: var(--text); padding: 12px 14px; font: inherit; }
  input[type="checkbox"] { width: auto; margin-right: 8px; }
  textarea { min-height: 120px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2); }
  input[type='range'] { padding: 0; background: transparent; border: 0; box-shadow: none; }
  button, .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 44px;
    padding: 11px 18px;
    border-radius: 12px;
    border: 1px solid transparent;
    background: var(--accent);
    color: white;
    text-decoration: none;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }
  button:hover, .button:hover { transform: translateY(-1px); box-shadow: 0 14px 30px rgba(59, 130, 246, 0.18); }
  button:disabled, .button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
  .button--secondary { background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.35); color: #bfdbfe; }
  .button--small { padding: 6px 12px; font-size: 0.82rem; }
  .button--danger { background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.35); color: #fecaca; }
  .button--apple { background: #020617; border-color: #334155; color: #e2e8f0; }
  .button__icon { font-size: 1rem; line-height: 1; }
  .layout { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
  .sidebar { display: flex; flex-direction: column; gap: 28px; padding: 28px 20px; background: var(--sidebar); border-right: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 14px; padding: 6px 6px 0; }
  .brand__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    border-radius: 14px;
    background: rgba(59, 130, 246, 0.16);
    color: #93c5fd;
    font-size: 1.1rem;
  }
  .brand__copy { display: grid; gap: 4px; }
  .brand__copy strong { font-size: 0.95rem; }
  .brand__copy span { color: var(--muted); font-size: 0.84rem; }
  .nav { display: grid; gap: 8px; }
  .nav__item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid transparent;
    color: #cbd5e1;
    text-decoration: none;
  }
  .nav__item:hover { background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.18); color: #f8fafc; }
  .nav__item.is-active { background: rgba(59, 130, 246, 0.14); border-color: rgba(59, 130, 246, 0.35); color: white; }
  .nav__icon { width: 18px; text-align: center; }
  .content { padding: 32px; }
  .panel { max-width: 1280px; margin: 0 auto; display: grid; gap: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 22px; padding: 28px; box-shadow: 0 24px 60px rgba(2, 6, 23, 0.38); }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.14);
    border: 1px solid rgba(148, 163, 184, 0.2);
    color: #e2e8f0;
    font-size: 0.82rem;
    font-weight: 700;
  }
  .pill--accent { background: rgba(59, 130, 246, 0.14); border-color: rgba(59, 130, 246, 0.28); color: #bfdbfe; }
  .pill--success { background: rgba(16, 185, 129, 0.14); border-color: rgba(16, 185, 129, 0.28); color: #a7f3d0; }
  .pill--danger { background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.28); color: #fecaca; }
  .notice {
    padding: 14px 16px;
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.75);
    color: #cbd5e1;
  }
  .notice--success { border-color: rgba(16, 185, 129, 0.3); background: rgba(6, 78, 59, 0.28); color: #d1fae5; }
  .notice--error { border-color: rgba(239, 68, 68, 0.32); background: rgba(127, 29, 29, 0.28); color: #fee2e2; }
  .notice--warning { border-color: rgba(245, 158, 11, 0.32); background: rgba(120, 53, 15, 0.28); color: #fde68a; }
  .field-hint { font-size: 0.84rem; font-weight: 400; color: var(--muted); }
  [hidden] { display: none !important; }
  @media (max-width: 767px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { gap: 18px; padding: 16px 16px 18px; border-right: 0; border-bottom: 1px solid var(--border); }
    .nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .nav__item { flex-direction: column; justify-content: center; gap: 8px; min-height: 72px; padding: 10px; text-align: center; }
    .content { padding: 20px; }
    .card { padding: 22px; }
  }
`;

function escapeAttr(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => HTML_ESCAPES[character] ?? character);
}

function validateNetworkInput(body: {
  preset?: string;
  rpcUrl?: string;
  faucetUrl?: string;
  packageId?: string;
  registryId?: string;
}): { preset: string; rpcUrl: string; faucetUrl: string; packageId: string; registryId: string } {
  const preset = (body.preset ?? 'custom').trim();
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

  return { preset, rpcUrl, faucetUrl, packageId, registryId };
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

class PortalSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalSettingsValidationError';
  }
}

class ProviderConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigValidationError';
  }
}

function isNetworkValidationError(error: unknown): boolean {
  return error instanceof NetworkValidationError;
}

function isProviderConfigValidationError(error: unknown): boolean {
  return error instanceof ProviderConfigValidationError;
}
