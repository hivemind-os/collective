import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  DisputeStatus,
  ReputationScoreCalculator,
  TaskStatus,
  completeTaskAndClaimWithCard,
  createBlobStore,
  createNetworkConfig,
  createPhase3Clients,
  createReputationEvent,
  createArtifactRoot,
  postTaskWithBlobStore,
  registerTestAgent,
  removeDirectoryWithRetries,
  waitForCondition,
  waitForDisputeStatus,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 3 E2E: Trust integration', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-trust-integration');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'combines staking, registry discovery, completed-task reputation, and reputation-aware provider selection',
    async () => {
      const requester = await network.createFundedWallet();
      const strongProvider = await network.createFundedWallet(25_000_000_000n);
      const weakProvider = await network.createFundedWallet();
      const observer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const observerClients = createPhase3Clients(config);
      const strongRegistration = await registerTestAgent({
        config,
        wallet: strongProvider,
        capabilityName: 'trusted-selection',
        name: 'Strong Provider',
      });
      const weakRegistration = await registerTestAgent({
        config,
        wallet: weakProvider,
        capabilityName: 'trusted-selection',
        name: 'Weak Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'trust-selection');
      const priceMist = 300_000_000n;

      await strongRegistration.clients.staking.depositStake({
        amountMist: 10_000_000_000n,
        stakeType: 'agent',
        signer: strongProvider.keypair,
      });

      const posted = await postTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'trust flow payload',
        capability: 'trusted-selection',
        priceMist,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });

      await completeTaskAndClaimWithCard({
        requesterTaskClient: requesterClients.task,
        providerTaskClient: strongRegistration.clients.task,
        blobStore,
        taskId: posted.taskId,
        inputData: posted.inputData,
        capability: 'trusted-selection',
        providerCardId: strongRegistration.agentCardId,
        providerKeypair: strongProvider.keypair,
      });

      const strongCard = await waitForCondition(async () => {
        const card = await strongRegistration.clients.registry.getAgentCard(strongRegistration.agentCardId);
        return card?.totalTasksCompleted === 1 && card.totalEarningsMist === priceMist ? card : undefined;
      }, 20_000, 'Strong provider counters were not updated');
      const weakCard = await weakRegistration.clients.registry.getAgentCard(weakRegistration.agentCardId);
      const calculator = new ReputationScoreCalculator();
      const scores = new Map([
        [
          strongRegistration.did,
          calculator.computeScore(strongCard, [
            createReputationEvent({
              subject: strongRegistration.did,
              taskId: posted.taskId,
              capability: 'trusted-selection',
              paymentAmount: { amount: priceMist.toString(), currency: 'MIST' },
            }),
          ]),
        ],
        [weakRegistration.did, calculator.computeScore(weakCard!, [])],
      ]);
      const ranked = await observerClients.registry.discoverByCapability('trusted-selection', 10, {
        sortByReputation: true,
        scores,
      });

      expect(strongCard.hasStake).toBe(true);
      expect(strongCard.stakeMist).toBe(10_000_000_000n);
      expect(ranked[0]?.id).toBe(strongRegistration.agentCardId);
      expect(ranked.some((agent) => agent.id === weakRegistration.agentCardId)).toBe(true);
      expect(scores.get(strongRegistration.did)?.successRate).toBeGreaterThan(scores.get(weakRegistration.did)?.successRate ?? 0);
      expect(observer.address).toBeTruthy();
    },
    60_000,
  );

  it(
    'uses marketplace recommendations to pick the highest-reputation provider among bidders',
    async () => {
      const requester = await network.createFundedWallet();
      const highProvider = await network.createFundedWallet(25_000_000_000n);
      const lowProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const highRegistration = await registerTestAgent({
        config,
        wallet: highProvider,
        capabilityName: 'market-trust',
        name: 'High Reputation Provider',
      });
      const lowRegistration = await registerTestAgent({
        config,
        wallet: lowProvider,
        capabilityName: 'market-trust',
        name: 'Low Reputation Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'marketplace-trust');
      const { blobId: historicalInputBlobId } = await blobStore.store(new TextEncoder().encode('history builder'));

      await highRegistration.clients.staking.depositStake({
        amountMist: 10_000_000_000n,
        stakeType: 'agent',
        signer: highProvider.keypair,
      });

      const historyTask = await requesterClients.task.postTask({
        capability: 'market-trust',
        category: 'analysis',
        inputBlobId: historicalInputBlobId,
        priceMist: 250_000_000n,
        disputeWindowMs: 0,
        expiryHours: 1,
        keypair: requester.keypair,
      });
      const historicalInput = new TextEncoder().encode('history builder');
      await completeTaskAndClaimWithCard({
        requesterTaskClient: requesterClients.task,
        providerTaskClient: highRegistration.clients.task,
        blobStore,
        taskId: historyTask.taskId,
        inputData: historicalInput,
        capability: 'market-trust',
        providerCardId: highRegistration.agentCardId,
        providerKeypair: highProvider.keypair,
      });

      const { blobId: marketInputBlobId } = await blobStore.store(new TextEncoder().encode('choose a provider'));
      const openTask = await requesterClients.marketplace.postOpenTask({
        capability: 'market-trust',
        category: 'analysis',
        inputBlobId: marketInputBlobId,
        priceMist: 550_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });

      await highRegistration.clients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 500_000_000n,
        signer: highProvider.keypair,
      });
      await lowRegistration.clients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 400_000_000n,
        signer: lowProvider.keypair,
      });

      const recommended = await requesterClients.marketplace.getRecommendedBid(openTask.taskId, {
        reputationWeight: 1_000_000n,
        priceWeight: 1n,
      });
      await requesterClients.marketplace.acceptBid({
        taskId: openTask.taskId,
        bidId: recommended!.bid.id,
        signer: requester.keypair,
      });

      const acceptedTask = await waitForTaskStatus(requesterClients.task, openTask.taskId, TaskStatus.ACCEPTED);

      expect(recommended?.bid.bidder).toBe(highProvider.address);
      expect(acceptedTask.provider).toBe(highProvider.address);
      expect(acceptedTask.price).toBe(500_000_000n);
    },
    60_000,
  );

  it(
    'shows that dispute rulings do not alter stake positions without separate slashing evidence',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet(25_000_000_000n);
      const arbitrator = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const providerRegistration = await registerTestAgent({
        config,
        wallet: provider,
        capabilityName: 'stake-dispute',
        name: 'Staked Provider',
      });
      const arbitratorClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'dispute-stake');
      const priceMist = 400_000_000n;

      const deposited = await providerRegistration.clients.staking.depositStake({
        amountMist: 10_000_000_000n,
        stakeType: 'agent',
        signer: provider.keypair,
      });
      const stakeBefore = await providerRegistration.clients.staking.getStakePosition(deposited.stakeId);

      const posted = await postTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'stake dispute payload',
        capability: 'stake-dispute',
        priceMist,
        disputeWindowMs: 60_000,
        keypair: requester.keypair,
      });

      await providerRegistration.clients.task.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.ACCEPTED);
      const { blobId: resultBlobId } = await blobStore.store(new TextEncoder().encode('completed result'));
      await providerRegistration.clients.task.completeTask({
        taskId: posted.taskId,
        resultBlobId,
        keypair: provider.keypair,
      });
      await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.COMPLETED);

      const { blobId: requesterEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('requester evidence'));
      const { blobId: providerEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('provider evidence'));
      const opened = await requesterClients.dispute.openDispute({
        taskId: posted.taskId,
        evidenceBlobId: requesterEvidenceBlobId,
        proposedSplitMist: 150_000_000n,
        arbitratorAddress: arbitrator.address,
        signer: requester.keypair,
      });
      await providerRegistration.clients.dispute.respondToDispute({
        disputeId: opened.disputeId,
        evidenceBlobId: providerEvidenceBlobId,
        proposedSplitMist: 100_000_000n,
        signer: provider.keypair,
      });
      await arbitratorClients.dispute.arbitrate({
        disputeId: opened.disputeId,
        taskId: posted.taskId,
        rulingSplitMist: 150_000_000n,
        signer: arbitrator.keypair,
      });

      const dispute = await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.ARBITRATED);
      const stakeAfter = await providerRegistration.clients.staking.getStakePosition(deposited.stakeId);

      expect(dispute.status).toBe(DisputeStatus.ARBITRATED);
      expect(stakeAfter?.balanceMist).toBe(stakeBefore?.balanceMist);
      expect(stakeAfter?.slashedAmount).toBe(0n);
      expect(stakeAfter?.isActive).toBe(true);
    },
    60_000,
  );
});
