import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  AggregationMode,
  CircuitBreaker,
  FanOutExecutor,
  PerformanceTracker,
  ProviderSelectionStrategy,
  ProviderSelector,
  TaskStatus,
  buildEchoResult,
  createArtifactRoot,
  createBlobStore,
  createNetworkConfig,
  createPhase4DbPath,
  postTaskWithBlobStore,
  registerPhase4Agent,
  removeDirectoryWithRetries,
  waitForCondition,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('Phase 4 E2E: Multi-provider routing', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase4-multi-provider');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'selects on-chain registered providers by cost, reputation, and speed while exercising circuit breakers and fan-out aggregation',
    async () => {
      const requester = await network.createFundedWallet();
      const providerCheap = await network.createFundedWallet();
      const providerStrong = await network.createFundedWallet();
      const providerFast = await network.createFundedWallet();
      const config = createNetworkConfig(network);

      const cheapRegistration = await registerPhase4Agent({
        config,
        wallet: providerCheap,
        capabilityName: 'route-echo',
        priceMist: 100_000_000n,
        name: 'Cheap Provider',
      });
      const strongRegistration = await registerPhase4Agent({
        config,
        wallet: providerStrong,
        capabilityName: 'route-echo',
        priceMist: 150_000_000n,
        name: 'Strong Provider',
      });
      const fastRegistration = await registerPhase4Agent({
        config,
        wallet: providerFast,
        capabilityName: 'route-echo',
        priceMist: 120_000_000n,
        name: 'Fast Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'multi-provider-blobs');
      const historicalTask = await postTaskWithBlobStore({
        taskClient: strongRegistration.clients.task,
        blobStore,
        input: 'strong reputation history',
        capability: 'route-echo',
        priceMist: 250_000_000n,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });

      await strongRegistration.clients.task.acceptTask({ taskId: historicalTask.taskId, keypair: providerStrong.keypair });
      await waitForTaskStatus(strongRegistration.clients.task, historicalTask.taskId, TaskStatus.ACCEPTED);
      const { blobId: resultBlobId } = await blobStore.store(
        buildEchoResult(historicalTask.taskId, 'route-echo', historicalTask.inputData),
      );
      await strongRegistration.clients.task.completeTask({
        taskId: historicalTask.taskId,
        resultBlobId,
        providerCardId: strongRegistration.agentCardId,
        keypair: providerStrong.keypair,
      });
      await waitForTaskStatus(strongRegistration.clients.task, historicalTask.taskId, TaskStatus.COMPLETED);
      await strongRegistration.clients.task.claimPayment({
        taskId: historicalTask.taskId,
        providerCardId: strongRegistration.agentCardId,
        keypair: providerStrong.keypair,
      });
      await waitForTaskStatus(strongRegistration.clients.task, historicalTask.taskId, TaskStatus.RELEASED);
      await waitForCondition(async () => {
        const card = await strongRegistration.clients.registry.getAgentCard(strongRegistration.agentCardId);
        return card?.totalTasksCompleted === 1 ? card : undefined;
      }, 20_000, 'Strong provider card did not accumulate completed-task reputation.');

      const discovered = await strongRegistration.clients.registry.discoverByCapability('route-echo', 10);
      const didByName = new Map(discovered.map((agent) => [agent.name, agent.did]));
      const performanceTracker = new PerformanceTracker({
        dbPath: await createPhase4DbPath(artifactRoot, 'multi-provider-performance', 'performance.sqlite'),
      });
      performanceTracker.recordCompletion(didByName.get('Cheap Provider')!, 'route-echo', 300, true);
      performanceTracker.recordCompletion(didByName.get('Strong Provider')!, 'route-echo', 220, true);
      performanceTracker.recordCompletion(didByName.get('Fast Provider')!, 'route-echo', 40, true);

      let now = Date.now();
      const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50, now: () => now });
      const selector = new ProviderSelector({ circuitBreaker: breaker, performanceTracker });

      const cheapest = selector.selectProviders(discovered, 'route-echo', ProviderSelectionStrategy.CHEAPEST, 3);
      const highestReputation = selector.selectProviders(discovered, 'route-echo', ProviderSelectionStrategy.HIGHEST_REPUTATION, 3);

      breaker.recordFailure(didByName.get('Cheap Provider')!);
      breaker.recordFailure(didByName.get('Cheap Provider')!);
      const weighted = selector.selectProviders(discovered, 'route-echo', ProviderSelectionStrategy.WEIGHTED, 3, {
        reputation: 0.2,
        price: 0.1,
        speed: 0.7,
      });

      expect(cheapest.map((provider) => provider.did)).toEqual([
        didByName.get('Cheap Provider'),
        didByName.get('Fast Provider'),
        didByName.get('Strong Provider'),
      ]);
      expect(highestReputation[0]?.did).toBe(didByName.get('Strong Provider'));
      expect(weighted.map((provider) => provider.did)).not.toContain(didByName.get('Cheap Provider'));
      expect(weighted[0]?.did).toBe(didByName.get('Fast Provider'));
      expect(breaker.isOpen(didByName.get('Cheap Provider')!)).toBe(true);

      now += 60;
      expect(breaker.getState(didByName.get('Cheap Provider')!)).toBe('half_open');
      breaker.recordSuccess(didByName.get('Cheap Provider')!);
      expect(breaker.getState(didByName.get('Cheap Provider')!)).toBe('closed');

      const fanOutAll = new FanOutExecutor({
        performanceTracker,
        executeProvider: async (provider) => ({
          value: { provider: provider.did, mode: 'all' },
          aggregateValue: provider.did,
          cost: provider.price,
        }),
      });
      const allResult = await fanOutAll.execute(
        {
          capability: 'route-echo',
          input: { prompt: 'phase4 fan-out' },
          fanOutCount: 2,
          strategy: ProviderSelectionStrategy.WEIGHTED,
          aggregation: AggregationMode.ALL,
          timeout: 250,
        },
        weighted,
      );

      const fanOutFirstSuccess = new FanOutExecutor({
        circuitBreaker: breaker,
        performanceTracker,
        executeProvider: async (provider, _request, context) => {
          if (provider.did === didByName.get('Fast Provider')) {
            await delay(10);
            return {
              value: { winner: provider.did },
              aggregateValue: provider.did,
              cost: provider.price,
            };
          }

          await new Promise((_, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted by winner')), { once: true });
          });
          return { value: null, cost: 0n };
        },
      });
      const firstSuccessResult = await fanOutFirstSuccess.execute(
        {
          capability: 'route-echo',
          input: { prompt: 'phase4 first success' },
          fanOutCount: 2,
          strategy: ProviderSelectionStrategy.WEIGHTED,
          aggregation: AggregationMode.FIRST_SUCCESS,
          timeout: 250,
        },
        weighted,
      );

      expect(allResult.aggregatedResult).toEqual([didByName.get('Fast Provider'), didByName.get('Strong Provider')]);
      expect(allResult.totalCost).toBe(270_000_000n);
      expect(allResult.results.map((entry) => entry.status)).toEqual(['success', 'success']);
      expect(firstSuccessResult.aggregatedResult).toBe(didByName.get('Fast Provider'));
      expect(firstSuccessResult.results.find((entry) => entry.provider === didByName.get('Fast Provider'))?.status).toBe('success');
      expect(firstSuccessResult.results.find((entry) => entry.provider === didByName.get('Strong Provider'))?.status).toBe('timeout');
      expect(performanceTracker.getEstimatedLatency(didByName.get('Fast Provider')!, 'route-echo')).toBeDefined();
      expect(performanceTracker.getProviderStats(didByName.get('Fast Provider')!).successCount).toBeGreaterThan(0);

      performanceTracker.close();
      expect(cheapRegistration.did).toBeTruthy();
      expect(fastRegistration.did).toBeTruthy();
    },
    90_000,
  );
});
