#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import pino from 'pino';

import open from 'open';

import type { DaemonAuthStatus, SessionMonitorAuthProvider } from './auth/session-monitor.js';
import { SessionMonitor } from './auth/session-monitor.js';
import { getConfigPath, loadConfig } from './config.js';
import { IpcServer } from './ipc/server.js';
import { DaemonLifecycle } from './lifecycle.js';
import { buildMeshToolContext } from './mcp/tool-context.js';
import { PortalServer, type PortalAuthProvider } from './portal/server.js';
import { loadProviderConfig, ProviderRuntime } from './provider/index.js';
import { createDaemonIdentityContext, DaemonState } from './state.js';

export async function main(): Promise<void> {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);

  if (config.daemon.logFile) {
    await mkdir(dirname(config.daemon.logFile), { recursive: true });
  }

  const destination = config.daemon.logFile ? pino.destination(config.daemon.logFile) : undefined;
  const logger = pino(
    {
      name: '@agentic-mesh/daemon',
      level: config.daemon.logLevel,
    },
    destination,
  );
  const lifecycle = new DaemonLifecycle(config.daemon.pidFile);

  if (await lifecycle.isRunning()) {
    logger.info('Daemon is already running.');
    process.exit(0);
  }

  let state: DaemonState | undefined;
  let ipcServer: IpcServer | undefined;
  let providerRuntime: ProviderRuntime | undefined;
  let setupPortal: PortalServer | undefined;
  let portal: PortalServer | undefined;
  let sessionMonitor: SessionMonitor | undefined;
  let reauthPortalOpen = false;

  try {
    await lifecycle.acquireLock();

    const identityContext = await createDaemonIdentityContext(config);
    const zkloginProvider =
      config.auth.mode === 'zklogin' ? (identityContext.authProvider as PortalAuthProvider & SessionMonitorAuthProvider) : undefined;
    sessionMonitor = zkloginProvider
      ? new SessionMonitor({
          authProvider: zkloginProvider,
          logger,
        })
      : undefined;

    if (zkloginProvider && !zkloginProvider.isAuthenticated()) {
      setupPortal = new PortalServer({
        config,
        configPath,
        authProvider: zkloginProvider,
        logger,
      });
      const portalUrl = await setupPortal.start();
      logger.info({ portalUrl }, 'Waiting for zkLogin onboarding');
      await openPortalUrl(portalUrl, logger, 'continue onboarding');
      await setupPortal.waitForAuth();
      await setupPortal.stop();
      setupPortal = undefined;
    }

    const daemonState = await DaemonState.create(config, identityContext);
    state = daemonState;
    daemonState.setProviderRunning(false);
    logger.info({ did: daemonState.did }, 'Daemon state initialized');

    const getAuthStatus = () => sessionMonitor?.getStatus() ?? createFallbackAuthStatus(daemonState);

    const openReauthPortal = async (force = false) => {
      const portalUrl = portal?.getReauthUrl() ?? null;
      if (!portalUrl) {
        return {
          portalUrl: null,
          browserOpened: false,
          status: getAuthStatus(),
        };
      }

      if (!force && reauthPortalOpen) {
        return {
          portalUrl,
          browserOpened: false,
          status: getAuthStatus(),
        };
      }

      const browserOpened = await openPortalUrl(portalUrl, logger, 're-authenticate');
      reauthPortalOpen ||= browserOpened;
      return {
        portalUrl,
        browserOpened,
        status: getAuthStatus(),
      };
    };

    if (zkloginProvider) {
      portal = new PortalServer({
        config,
        configPath,
        authProvider: zkloginProvider,
        state: daemonState,
        logger,
        getAuthStatus,
      });
      const portalUrl = await portal.start();
      logger.info({ portalUrl }, 'Portal server listening');
    }

    ipcServer = new IpcServer(config.daemon.ipcPath, daemonState, {
      getAuthStatus,
      triggerReauth: () => openReauthPortal(true),
    });
    ipcServer.toolContext = buildMeshToolContext(daemonState, config.daemon.dataDir);
    await ipcServer.start();
    logger.info({ ipcPath: config.daemon.ipcPath }, 'IPC server listening');

    if (sessionMonitor) {
      sessionMonitor.on('session:expiring', (status) => {
        ipcServer?.notifyAuthStatusChanged(status);
      });
      sessionMonitor.on('session:expired', async (status) => {
        ipcServer?.notifyAuthStatusChanged(status);
        await openReauthPortal(false);
      });
      sessionMonitor.on('session:refreshed', (status) => {
        reauthPortalOpen = false;
        ipcServer?.notifyAuthStatusChanged(status);
      });
      sessionMonitor.on('session:reauth_required', async (status) => {
        ipcServer?.notifyAuthStatusChanged(status);
        await openReauthPortal(false);
      });
      sessionMonitor.start();
    }

    const providerConfig = loadProviderConfig(config);
    if (providerConfig?.enabled) {
      const ipcRef = ipcServer;
      providerRuntime = new ProviderRuntime({
        state: daemonState,
        providerConfig,
        cursorDbPath: join(config.daemon.dataDir, 'provider-cursors.db'),
        relayConfig: config.relay,
        mcpSamplingFn: ipcRef
          ? async (appName, params) => {
              const server = ipcRef.getMcpServerForApp(appName);
              if (!server) {
                throw new Error(`No MCP client connected with appName "${appName}"`);
              }
              return server.createMessage(params);
            }
          : undefined,
      });
      await providerRuntime.start();
      daemonState.setProviderRunning(true);
      logger.info('Provider runtime started');
    }

    lifecycle.setupSignalHandlers(async () => {
      logger.info('Shutting down...');
      sessionMonitor?.stop();
      state?.setProviderRunning(false);
      await providerRuntime?.stop();
      await ipcServer?.stop();
      await portal?.stop();
      await state?.shutdown();
      await lifecycle.releaseLock();
      logger.info('Daemon stopped');
    });
  } catch (error) {
    sessionMonitor?.stop();
    state?.setProviderRunning(false);
    await cleanupWithLogging(logger, 'provider runtime', () => providerRuntime?.stop());
    await cleanupWithLogging(logger, 'IPC server', () => ipcServer?.stop());
    await cleanupWithLogging(logger, 'setup portal server', () => setupPortal?.stop());
    await cleanupWithLogging(logger, 'portal server', () => portal?.stop());
    await cleanupWithLogging(logger, 'daemon state', () => state?.shutdown());
    await cleanupWithLogging(logger, 'daemon lock', () => lifecycle.releaseLock());
    throw error;
  }
}

async function cleanupWithLogging(
  logger: { warn: (bindings: { err: unknown }, message: string) => void },
  label: string,
  cleanup: () => Promise<void> | undefined,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    logger.warn({ err: error }, `Failed to clean up ${label}.`);
  }
}

function createFallbackAuthStatus(state: DaemonState): DaemonAuthStatus {
  const authenticated = state.authProvider.isAuthenticated();
  return {
    authMode: state.authProvider.mode,
    authenticated,
    state: authenticated ? 'authenticated' : 'reauth_required',
    address: authenticated ? state.address : null,
    expiresAt: null,
    expiresInMs: null,
    refreshAvailable: false,
    lastError: null,
    updatedAt: Date.now(),
  };
}

async function openPortalUrl(
  portalUrl: string,
  logger: {
    info: (bindings: { portalUrl: string }, message: string) => void;
    warn: (bindings: { portalUrl: string; err?: unknown }, message: string) => void;
  },
  action: string,
): Promise<boolean> {
  if (isHeadlessEnvironment()) {
    logger.warn({ portalUrl }, `Headless environment detected. Open the portal URL manually to ${action}.`);
    return false;
  }

  try {
    await open(portalUrl);
    return true;
  } catch (error) {
    logger.warn({ err: error, portalUrl }, 'Failed to open browser automatically.');
    logger.info({ portalUrl }, `Open the portal URL manually to ${action}.`);
    return false;
  }
}

function isHeadlessEnvironment(): boolean {
  if (process.env.MESH_HEADLESS === '1' || process.env.CI === 'true') {
    return true;
  }

  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
    return true;
  }

  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
