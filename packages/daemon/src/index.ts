#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import pino from 'pino';

import { loadConfig } from './config.js';
import { IpcServer } from './ipc/server.js';
import { DaemonLifecycle } from './lifecycle.js';
import { loadProviderConfig, ProviderRuntime } from './provider/index.js';
import { DaemonState } from './state.js';

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

  try {
    await lifecycle.acquireLock();

    state = await DaemonState.create(config);
    state.setProviderRunning(false);
    logger.info({ did: state.did }, 'Daemon state initialized');

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
      await state?.shutdown();
      await lifecycle.releaseLock();
      logger.info('Daemon stopped');
    });
  } catch (error) {
    state?.setProviderRunning(false);
    await cleanupWithLogging(logger, 'provider runtime', () => providerRuntime?.stop());
    await cleanupWithLogging(logger, 'IPC server', () => ipcServer?.stop());
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

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
