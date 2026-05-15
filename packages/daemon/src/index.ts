#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import pino from 'pino';

import open from 'open';

import { loadConfig } from './config.js';
import { IpcServer } from './ipc/server.js';
import { DaemonLifecycle } from './lifecycle.js';
import { PortalServer, type PortalAuthProvider } from './portal/server.js';
import { loadProviderConfig, ProviderRuntime } from './provider/index.js';
import { createDaemonIdentityContext, DaemonState } from './state.js';

export async function main(): Promise<void> {
  const config = loadConfig();

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

  try {
    await lifecycle.acquireLock();

    const identityContext = await createDaemonIdentityContext(config);
    const zkloginProvider =
      config.auth.mode === 'zklogin' ? (identityContext.authProvider as PortalAuthProvider) : undefined;
    if (zkloginProvider && !zkloginProvider.isAuthenticated()) {
      setupPortal = new PortalServer({
        config,
        authProvider: zkloginProvider,
      });
      const portalUrl = await setupPortal.start();
      logger.info({ portalUrl }, 'Waiting for zkLogin onboarding');
      await openBrowser(portalUrl, logger);
      await setupPortal.waitForAuth();
      await setupPortal.stop();
      setupPortal = undefined;
    }

    state = await DaemonState.create(config, identityContext);
    state.setProviderRunning(false);
    logger.info({ did: state.did }, 'Daemon state initialized');

    if (zkloginProvider) {
      portal = new PortalServer({
        config,
        authProvider: zkloginProvider,
        state,
      });
      const portalUrl = await portal.start();
      logger.info({ portalUrl }, 'Portal server listening');
    }

    ipcServer = new IpcServer(config.daemon.ipcPath, state);
    await ipcServer.start();
    logger.info({ ipcPath: config.daemon.ipcPath }, 'IPC server listening');

    const providerConfig = loadProviderConfig(config);
    if (providerConfig?.enabled) {
      providerRuntime = new ProviderRuntime({
        state,
        providerConfig,
        cursorDbPath: join(config.daemon.dataDir, 'provider-cursors.db'),
      });
      await providerRuntime.start();
      state.setProviderRunning(true);
      logger.info('Provider runtime started');
    }

    lifecycle.setupSignalHandlers(async () => {
      logger.info('Shutting down...');
      state?.setProviderRunning(false);
      await providerRuntime?.stop();
      await ipcServer?.stop();
      await portal?.stop();
      await state?.shutdown();
      await lifecycle.releaseLock();
      logger.info('Daemon stopped');
    });
  } catch (error) {
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

async function openBrowser(
  portalUrl: string,
  logger: {
    info: (bindings: { portalUrl: string }, message: string) => void;
    warn: (bindings: { err: unknown; portalUrl: string }, message: string) => void;
  },
): Promise<void> {
  try {
    await open(portalUrl);
  } catch (error) {
    logger.warn({ err: error, portalUrl }, 'Failed to open browser automatically.');
    logger.info({ portalUrl }, 'Open the portal URL manually to continue onboarding');
  }
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
