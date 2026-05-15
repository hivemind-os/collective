import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import pino from 'pino';

import { MeshSuiClient } from '@agentic-mesh/core';

import { AnalyticsEngine } from './analytics.js';
import { loadIndexerConfig } from './config.js';
import { createIndexerGraphQLServer } from './graphql/server.js';
import { MeshIndexer } from './indexer.js';
import { IndexerStore } from './store.js';

export * from './analytics.js';
export * from './config.js';
export * from './graphql/server.js';
export * from './indexer.js';
export * from './store.js';

export async function startIndexerService() {
  const config = loadIndexerConfig();
  const logger = pino({ name: '@agentic-mesh/indexer', level: 'info' });

  await mkdir(dirname(config.sqlitePath), { recursive: true });

  const store = new IndexerStore(config.sqlitePath);
  const analytics = new AnalyticsEngine(store);
  const suiClient = new MeshSuiClient({
    rpcUrl: config.rpcUrl,
    faucetUrl: '',
    packageId: config.packageId,
    registryId: '',
  });
  const indexer = new MeshIndexer({
    suiClient,
    store,
    packageId: config.packageId,
    pollIntervalMs: config.pollingIntervalMs,
    startCheckpoint: config.backfill.fromCheckpoint,
    logger,
  });
  const graphql = createIndexerGraphQLServer({
    store,
    analytics,
    host: config.server.host,
    port: config.server.port,
    logger,
  });

  await indexer.backfill(config.backfill.fromCheckpoint);
  indexer.start();
  const address = await graphql.start();

  const stop = async () => {
    await indexer.stop();
    await graphql.stop();
    store.close();
  };

  return {
    config,
    store,
    analytics,
    indexer,
    graphql,
    address,
    stop,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startIndexerService();
    console.log(service.address);

    const shutdown = async () => {
      await service.stop();
      process.exit(0);
    };

    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
