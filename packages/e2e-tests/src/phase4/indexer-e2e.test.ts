import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  AnalyticsEngine,
  IndexerStore,
  MeshIndexer,
  TaskStatus,
  buildEchoResult,
  createArtifactRoot,
  createBlobStore,
  createNetworkConfig,
  createPhase4Clients,
  createPhase4DbPath,
  encoder,
  registerPhase4Agent,
  removeDirectoryWithRetries,
  startPhase4GraphQLServer,
  waitForIndexedTask,
  waitForTaskStatus,
  postGraphQL,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 4 E2E: Indexer', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase4-indexer');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'indexes local Sui activity into SQLite, supports task queries, aggregates analytics, and serves GraphQL over HTTP',
    async () => {
      const requester = await network.createFundedWallet();
      const providerAlpha = await network.createFundedWallet();
      const providerBeta = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase4Clients(config);
      const alphaRegistration = await registerPhase4Agent({
        config,
        wallet: providerAlpha,
        capabilityName: 'indexer-echo',
        priceMist: 150_000_000n,
        name: 'Indexer Alpha',
      });
      await registerPhase4Agent({
        config,
        wallet: providerBeta,
        capabilityName: 'indexer-echo',
        priceMist: 175_000_000n,
        name: 'Indexer Beta',
      });
      const blobStore = await createBlobStore(artifactRoot, 'indexer-blobs');
      const { blobId: releasedInputBlobId } = await blobStore.store(encoder.encode('indexer released task'));
      const { blobId: openInputBlobId } = await blobStore.store(encoder.encode('indexer open task'));
      const { blobId: liveInputBlobId } = await blobStore.store(encoder.encode('indexer live task'));

      const releasedPosted = await requesterClients.task.postTask({
        capability: 'indexer-echo',
        category: 'analysis',
        inputBlobId: releasedInputBlobId,
        priceMist: 150_000_000n,
        disputeWindowMs: 0,
        expiryHours: 1,
        keypair: requester.keypair,
      });
      await alphaRegistration.clients.task.acceptTask({
        taskId: releasedPosted.taskId,
        keypair: providerAlpha.keypair,
      });
      await waitForTaskStatus(requesterClients.task, releasedPosted.taskId, TaskStatus.ACCEPTED);
      const releasedResult = buildEchoResult(releasedPosted.taskId, 'indexer-echo', encoder.encode('indexer released task'));
      const { blobId: releasedResultBlobId } = await blobStore.store(releasedResult);
      await alphaRegistration.clients.task.completeTask({
        taskId: releasedPosted.taskId,
        resultBlobId: releasedResultBlobId,
        providerCardId: alphaRegistration.agentCardId,
        keypair: providerAlpha.keypair,
      });
      await waitForTaskStatus(requesterClients.task, releasedPosted.taskId, TaskStatus.COMPLETED);
      await requesterClients.task.releasePayment({ taskId: releasedPosted.taskId, keypair: requester.keypair });
      await waitForTaskStatus(requesterClients.task, releasedPosted.taskId, TaskStatus.RELEASED);

      const openPosted = await requesterClients.task.postTask({
        capability: 'indexer-echo',
        category: 'research',
        inputBlobId: openInputBlobId,
        priceMist: 200_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        keypair: requester.keypair,
      });

      const store = new IndexerStore(await createPhase4DbPath(artifactRoot, 'indexer-store', 'indexer.sqlite'));
      const analytics = new AnalyticsEngine(store);
      const indexer = new MeshIndexer({
        suiClient: requesterClients.sui,
        store,
        packageId: config.packageId,
        pollIntervalMs: 200,
        startCheckpoint: 0,
      });

      let graphql: Awaited<ReturnType<typeof startPhase4GraphQLServer>> | undefined;
      try {
        expect(await indexer.backfill(0)).toBeGreaterThan(0);

        const releasedTask = await waitForIndexedTask(
          store,
          releasedPosted.taskId,
          (task) => task.status === TaskStatus.RELEASED && task.provider === providerAlpha.address,
        );
        const openTasks = store.queryTasks({ status: TaskStatus.OPEN, limit: 10 });
        const requesterTasks = store.queryTasks({ requester: requester.address, limit: 10 });
        const researchTasks = store.queryTasks({ category: 'research', limit: 10 });
        const summary = analytics.getSummary();
        const storedEventCount = Number(
          (store.getDatabase().prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number | bigint }).count,
        );

        expect(releasedTask.resultBlobId).toBe(releasedResultBlobId);
        expect(openTasks.map((task) => task.id)).toContain(openPosted.taskId);
        expect(requesterTasks).toHaveLength(2);
        expect(researchTasks.map((task) => task.id)).toEqual([openPosted.taskId]);
        expect(summary.totalAgents).toBe(2);
        expect(summary.activeAgents).toBe(2);
        expect(summary.totalTasks).toBe(2);
        expect(summary.completedTasks).toBe(1);
        expect(summary.totalVolumeMist).toBe(350_000_000n);
        expect(storedEventCount).toBeGreaterThanOrEqual(6);

        indexer.start();
        const livePosted = await requesterClients.task.postTask({
          capability: 'indexer-echo',
          category: 'analysis',
          inputBlobId: liveInputBlobId,
          priceMist: 125_000_000n,
          disputeWindowMs: 60_000,
          expiryHours: 1,
          keypair: requester.keypair,
        });
        await waitForIndexedTask(store, livePosted.taskId, (task) => task.status === TaskStatus.OPEN);

        graphql = await startPhase4GraphQLServer({ store, analytics, host: '127.0.0.1' });
        const payload = await postGraphQL<{
          agents: { totalCount: number; nodes: Array<{ did: string; name: string; categories: string[] }> };
          tasks: { nodes: Array<{ id: string; status: string; category: string; price: string }> };
          analytics: { totalAgents: number; totalTasks: number; totalVolumeMist: string };
        }>(
          graphql.address,
          `query Phase4Indexer($requester: String!) {
            agents(limit: 10) {
              totalCount
              nodes {
                did
                name
                categories
              }
            }
            tasks(requester: $requester, limit: 10) {
              nodes {
                id
                status
                category
                price
              }
            }
            analytics {
              totalAgents
              totalTasks
              totalVolumeMist
            }
          }`,
          { requester: requester.address },
        );

        expect(graphql.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphql$/);
        expect(payload.agents.totalCount).toBe(2);
        expect(payload.agents.nodes.map((agent) => agent.name).sort()).toEqual(['Indexer Alpha', 'Indexer Beta']);
        expect(payload.tasks.nodes.map((task) => task.id)).toEqual([livePosted.taskId, openPosted.taskId, releasedPosted.taskId]);
        expect(payload.tasks.nodes.map((task) => task.status)).toEqual(['OPEN', 'OPEN', 'RELEASED']);
        expect(payload.analytics).toEqual({
          totalAgents: 2,
          totalTasks: 3,
          totalVolumeMist: '475000000',
        });
        expect(payload.agents.nodes.find((agent) => agent.name === 'Indexer Alpha')?.categories).toContain('analysis');
      } finally {
        await indexer.stop();
        await graphql?.stop();
        store.close();
      }
    },
    90_000,
  );
});
