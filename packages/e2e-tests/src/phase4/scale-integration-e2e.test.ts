import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  AggregationMode,
  AnalyticsEngine,
  FanOutExecutor,
  PerformanceTracker,
  PaymentScheme,
  ProviderSelectionStrategy,
  ProviderSelector,
  ResultVerifier,
  TaskStatus,
  buildMeteredResultArtifacts,
  createArtifactRoot,
  createBlobStore,
  createNetworkConfig,
  createPhase4Clients,
  createPhase4DbPath,
  encoder,
  findEventByFields,
  getMeteredResultUnits,
  parseMeteredResultEnvelope,
  postGraphQL,
  postMeteredTaskWithBlobStore,
  registerPhase4Agent,
  removeDirectoryWithRetries,
  startPhase4GraphQLServer,
  waitForBidStatus,
  waitForCondition,
  waitForIndexedTask,
  waitForTaskStatus,
  IndexerStore,
  MeshIndexer,
} from './test-helpers.js';
import { BidStatus } from '@agentic-mesh/types';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 4 E2E: Scale integrations', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase4-scale-integrations');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'combines staking, metered task bidding, hash-chain verification, provider payment accounting, and indexer capture',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet(25_000_000_000n);
      const config = createNetworkConfig(network);
      const requesterClients = createPhase4Clients(config);
      const providerRegistration = await registerPhase4Agent({
        config,
        wallet: provider,
        capabilityName: 'scale-metered',
        priceMist: 500_000_000n,
        name: 'Scale Metered Provider',
      });
      await providerRegistration.clients.staking.depositStake({
        amountMist: 10_000_000_000n,
        stakeType: 'agent',
        signer: provider.keypair,
      });
      const blobStore = await createBlobStore(artifactRoot, 'scale-metered-blobs');
      const store = new IndexerStore(await createPhase4DbPath(artifactRoot, 'scale-indexer-store', 'scale-indexer.sqlite'));
      const analytics = new AnalyticsEngine(store);
      const indexer = new MeshIndexer({
        suiClient: requesterClients.sui,
        store,
        packageId: config.packageId,
        pollIntervalMs: 200,
        startCheckpoint: 0,
      });

      try {
        await indexer.backfill(0);
        indexer.start();

        const posted = await postMeteredTaskWithBlobStore({
          taskClient: requesterClients.task,
          blobStore,
          input: 'scale metered request',
          capability: 'scale-metered',
          maxPriceMist: 600_000_000n,
          unitPriceMist: 100_000_000n,
          disputeWindowMs: 0,
          keypair: requester.keypair,
        });
        const bid = await providerRegistration.clients.marketplace.placeBid({
          taskId: posted.taskId,
          bidPriceMist: 500_000_000n,
          reputationScore: 80n,
          signer: provider.keypair,
        });
        await requesterClients.marketplace.acceptBid({
          taskId: posted.taskId,
          bidId: bid.bidId,
          signer: requester.keypair,
        });

        const acceptedTask = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.ACCEPTED);
        expect(acceptedTask.paymentScheme).toBe(PaymentScheme.UPTO);
        expect(acceptedTask.price).toBe(500_000_000n);
        await waitForBidStatus(requesterClients.marketplace, bid.bidId, BidStatus.ACCEPTED);

        const resultArtifacts = buildMeteredResultArtifacts({
          taskId: posted.taskId,
          resultData: encoder.encode('scale metered execution result'),
          maxPrice: 500_000_000n,
          unitPrice: 100_000_000n,
          unitChunkSize: 12,
        });
        const { blobId: resultBlobId } = await blobStore.store(resultArtifacts.envelopeBytes);
        await providerRegistration.clients.task.completeMeteredTask({
          taskId: posted.taskId,
          resultBlobId,
          meteredUnits: resultArtifacts.meter.getActualUnits(),
          verificationHash: resultArtifacts.meter.getVerificationHash(),
          providerCardId: providerRegistration.agentCardId,
          keypair: provider.keypair,
        });

        const completedTask = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.COMPLETED);
        const storedResult = await blobStore.fetch(resultBlobId);
        const parsedEnvelope = parseMeteredResultEnvelope(storedResult ?? new Uint8Array());
        const verifier = new ResultVerifier();

        expect(completedTask.price).toBe(300_000_000n);
        expect(parsedEnvelope).not.toBeNull();
        expect(verifier.verify(completedTask, parsedEnvelope!.proof, getMeteredResultUnits(parsedEnvelope!))).toBe(true);

        await providerRegistration.clients.task.claimPayment({
          taskId: posted.taskId,
          providerCardId: providerRegistration.agentCardId,
          keypair: provider.keypair,
        });
        await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.RELEASED);
        await indexer.pollOnce();

        const releaseEvent = await findEventByFields(
          requesterClients.sui,
          `${config.packageId}::task::TaskPaymentReleased`,
          (payload) => payload.task_id === posted.taskId,
        );
        const providerCard = await waitForCondition(async () => {
          const card = await providerRegistration.clients.registry.getAgentCard(providerRegistration.agentCardId);
          return card?.totalTasksCompleted === 1 && card.totalEarningsMist === 300_000_000n ? card : undefined;
        }, 20_000, 'Provider reputation counters were not updated after the metered release.');
        const indexedTask = await waitForIndexedTask(store, posted.taskId);
        const indexedEventTypes = new Set(
          (
            store
              .getDatabase()
              .prepare('SELECT event_type FROM events WHERE tx_digest IN (SELECT tx_digest FROM events WHERE event_type LIKE ?) ORDER BY event_type ASC')
              .all('%::task::%') as Array<{ event_type: string }>
          ).map((row) => row.event_type),
        );
        const graphql = await startPhase4GraphQLServer({ store, analytics, host: '127.0.0.1' });
        try {
          const graphqlPayload = await postGraphQL<{
            task: { id: string; status: string; price: string; meteredUnits: number | null; verificationHash: string | null };
            analytics: { totalTasks: number; totalAgents: number };
          }>(
            graphql.address,
            `query ScaleFlow($taskId: String!) {
              task(id: $taskId) {
                id
                status
                price
                meteredUnits
                verificationHash
              }
              analytics {
                totalTasks
                totalAgents
              }
            }`,
            { taskId: posted.taskId },
          );

          expect(graphqlPayload.task).toEqual({
            id: posted.taskId,
            status: 'RELEASED',
            price: '300000000',
            meteredUnits: 3,
            verificationHash: resultArtifacts.meter.getVerificationHash(),
          });
          expect(graphqlPayload.analytics).toEqual({ totalTasks: 1, totalAgents: 1 });
        } finally {
          await graphql.stop();
        }

        expect(BigInt(String(releaseEvent?.refund_amount ?? 0))).toBe(200_000_000n);
        expect(providerCard.hasStake).toBe(true);
        expect(providerCard.stakeMist).toBe(10_000_000_000n);
        expect(indexedTask.meteredUnits).toBe(3);
        expect(indexedTask.verificationHash).toBe(resultArtifacts.meter.getVerificationHash());
        expect(store.getBids(posted.taskId, BidStatus.ACCEPTED)).toHaveLength(1);
        expect(indexedEventTypes.has(`${config.packageId}::task::TaskCompleted`)).toBe(true);
        expect(indexedEventTypes.has(`${config.packageId}::task::TaskPaymentReleased`)).toBe(true);
      } finally {
        await indexer.stop();
        store.close();
      }
    },
    90_000,
  );

  it(
    'selects real registered providers for a metered task and compares mocked fan-out metered results',
    async () => {
      const requester = await network.createFundedWallet();
      const providerA = await network.createFundedWallet();
      const providerB = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase4Clients(config);
      await registerPhase4Agent({
        config,
        wallet: providerA,
        capabilityName: 'scale-compare',
        priceMist: 150_000_000n,
        name: 'Scale Compare A',
      });
      await registerPhase4Agent({
        config,
        wallet: providerB,
        capabilityName: 'scale-compare',
        priceMist: 130_000_000n,
        name: 'Scale Compare B',
      });
      const blobStore = await createBlobStore(artifactRoot, 'scale-compare-blobs');
      const posted = await postMeteredTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'compare fan-out providers',
        capability: 'scale-compare',
        maxPriceMist: 400_000_000n,
        unitPriceMist: 100_000_000n,
        disputeWindowMs: 60_000,
        keypair: requester.keypair,
      });
      const agents = await requesterClients.registry.discoverByCapability('scale-compare', 10);
      const tracker = new PerformanceTracker({
        dbPath: await createPhase4DbPath(artifactRoot, 'scale-compare-performance', 'compare.sqlite'),
      });
      tracker.recordCompletion(agents.find((agent) => agent.name === 'Scale Compare A')!.did, 'scale-compare', 180, true);
      tracker.recordCompletion(agents.find((agent) => agent.name === 'Scale Compare B')!.did, 'scale-compare', 60, true);

      const selector = new ProviderSelector({ performanceTracker: tracker });
      const selected = selector.selectProviders(agents, 'scale-compare', ProviderSelectionStrategy.WEIGHTED, 2, {
        reputation: 0,
        price: 0.4,
        speed: 0.6,
      });
      const resultByDid = new Map(
        selected.map((provider, index) => {
          const artifacts = buildMeteredResultArtifacts({
            taskId: `${posted.taskId}-${index}`,
            resultData: encoder.encode(index === 0 ? 'provider-b-metered' : 'provider-a-metered'),
            maxPrice: 400_000_000n,
            unitPrice: 100_000_000n,
            unitChunkSize: 9,
          });
          return [provider.did, { cost: artifacts.meter.getCost(), verificationHash: artifacts.meter.getVerificationHash() }] as const;
        }),
      );
      const executor = new FanOutExecutor({
        performanceTracker: tracker,
        executeProvider: async (provider) => ({
          value: {
            provider: provider.did,
            actualCost: resultByDid.get(provider.did)!.cost,
            verificationHash: resultByDid.get(provider.did)!.verificationHash,
          },
          aggregateValue: {
            provider: provider.did,
            verificationHash: resultByDid.get(provider.did)!.verificationHash,
          },
          cost: resultByDid.get(provider.did)!.cost,
        }),
      });
      const result = await executor.execute(
        {
          capability: 'scale-compare',
          input: { taskId: posted.taskId },
          fanOutCount: 2,
          strategy: ProviderSelectionStrategy.WEIGHTED,
          aggregation: AggregationMode.ALL,
          timeout: 250,
        },
        selected,
      );

      expect(selected).toHaveLength(2);
      expect(selected[0]?.did).toBe(agents.find((agent) => agent.name === 'Scale Compare B')?.did);
      expect(result.results).toHaveLength(2);
      expect(result.aggregatedResult).toEqual(
        selected.map((provider) => ({
          provider: provider.did,
          verificationHash: resultByDid.get(provider.did)!.verificationHash,
        })),
      );
      expect(result.totalCost).toBe(
        selected.reduce((sum, provider) => sum + resultByDid.get(provider.did)!.cost, 0n),
      );
      expect(
        result.results
          .map((entry) => entry.result as { actualCost: bigint })
          .sort((left, right) => Number(left.actualCost - right.actualCost))[0]?.actualCost,
      ).toBe(200_000_000n);
      tracker.close();
    },
    90_000,
  );
});
