import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  BidStatus,
  TaskStatus,
  createBlobStore,
  createNetworkConfig,
  createPhase3Clients,
  createArtifactRoot,
  encoder,
  findEventByFields,
  removeDirectoryWithRetries,
  waitForBidStatus,
  waitForCondition,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 3 E2E: Marketplace', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-marketplace');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'posts categorized open tasks, accepts a bid, refunds price differences, rejects losing bids, and browses by category',
    async () => {
      const requester = await network.createFundedWallet();
      const providerLow = await network.createFundedWallet();
      const providerMid = await network.createFundedWallet();
      const providerHigh = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const lowClients = createPhase3Clients(config);
      const midClients = createPhase3Clients(config);
      const highClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'marketplace-main');
      const { blobId: inputBlobId } = await blobStore.store(encoder.encode('open marketplace task'));
      const { blobId: otherBlobId } = await blobStore.store(encoder.encode('non matching category'));
      const escrowPrice = 600_000_000n;

      const openTask = await requesterClients.marketplace.postOpenTask({
        capability: 'market-analysis',
        category: 'analysis',
        inputBlobId,
        priceMist: escrowPrice,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });
      await requesterClients.marketplace.postOpenTask({
        capability: 'market-code',
        category: 'code',
        inputBlobId: otherBlobId,
        priceMist: escrowPrice,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });

      const analysisTasks = await requesterClients.marketplace.browseOpenTasks({ category: 'analysis', limit: 10 });
      expect(analysisTasks.some((task) => task.id === openTask.taskId)).toBe(true);
      expect(analysisTasks.every((task) => task.category === 'analysis')).toBe(true);

      const lowBid = await lowClients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 300_000_000n,
        reputationScore: 40n,
        signer: providerLow.keypair,
      });
      const midBid = await midClients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 450_000_000n,
        reputationScore: 80n,
        signer: providerMid.keypair,
      });
      const highBid = await highClients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 500_000_000n,
        reputationScore: 10n,
        signer: providerHigh.keypair,
      });

      const bids = await requesterClients.marketplace.getBidsForTask(openTask.taskId);
      expect(bids).toHaveLength(3);

      const requesterBalanceBeforeAccept = await requesterClients.sui.getBalance(requester.address);
      await requesterClients.marketplace.acceptBid({
        taskId: openTask.taskId,
        bidId: lowBid.bidId,
        signer: requester.keypair,
      });

      const acceptedTask = await waitForTaskStatus(requesterClients.task, openTask.taskId, TaskStatus.ACCEPTED);
      const acceptedBid = await waitForBidStatus(requesterClients.marketplace, lowBid.bidId, BidStatus.ACCEPTED);
      const rejectedMidBid = await waitForBidStatus(requesterClients.marketplace, midBid.bidId, BidStatus.REJECTED);
      const rejectedHighBid = await waitForBidStatus(requesterClients.marketplace, highBid.bidId, BidStatus.REJECTED);
      const requesterBalanceAfterAccept = await requesterClients.sui.getBalance(requester.address);
      const acceptedEvent = await findEventByFields(
        requesterClients.sui,
        `${config.packageId}::marketplace::BidAccepted`,
        (payload) => payload.bid_id === lowBid.bidId,
      );
      const stillOpenAnalysisTasks = await requesterClients.marketplace.browseOpenTasks({ category: 'analysis', limit: 10 });

      expect(acceptedTask.provider).toBe(providerLow.address);
      expect(acceptedTask.status).toBe(TaskStatus.ACCEPTED);
      expect(acceptedTask.price).toBe(300_000_000n);
      expect(acceptedBid.status).toBe(BidStatus.ACCEPTED);
      expect(rejectedMidBid.status).toBe(BidStatus.REJECTED);
      expect(rejectedHighBid.status).toBe(BidStatus.REJECTED);
      expect(BigInt(String(acceptedEvent?.refunded_amount ?? 0))).toBe(300_000_000n);
      expect(requesterBalanceAfterAccept).toBeGreaterThan(requesterBalanceBeforeAccept);
      expect(stillOpenAnalysisTasks.some((task) => task.id === openTask.taskId)).toBe(false);
    },
    60_000,
  );

  it(
    'keeps competing bids active when acceptBid is called without rejection',
    async () => {
      const requester = await network.createFundedWallet();
      const acceptedProvider = await network.createFundedWallet();
      const remainingProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const acceptedClients = createPhase3Clients(config);
      const remainingClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'keep-competing-bids');
      const { blobId: inputBlobId } = await blobStore.store(encoder.encode('keep bids task'));

      const openTask = await requesterClients.marketplace.postOpenTask({
        capability: 'market-analysis',
        category: 'analysis',
        inputBlobId,
        priceMist: 500_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });

      const acceptedBid = await acceptedClients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 350_000_000n,
        reputationScore: 90n,
        signer: acceptedProvider.keypair,
      });
      const remainingBid = await remainingClients.marketplace.placeBid({
        taskId: openTask.taskId,
        bidPriceMist: 360_000_000n,
        reputationScore: 85n,
        signer: remainingProvider.keypair,
      });

      const accepted = await requesterClients.marketplace.acceptBid({
        taskId: openTask.taskId,
        bidId: acceptedBid.bidId,
        rejectCompeting: false,
        signer: requester.keypair,
      });

      const task = await waitForTaskStatus(requesterClients.task, openTask.taskId, TaskStatus.ACCEPTED);
      const chosenBid = await waitForBidStatus(requesterClients.marketplace, acceptedBid.bidId, BidStatus.ACCEPTED);
      const stillActiveBid = await waitForCondition(async () => {
        const bid = await requesterClients.marketplace.getBid(remainingBid.bidId);
        return bid?.status === BidStatus.ACTIVE ? bid : undefined;
      }, 20_000, `Bid ${remainingBid.bidId} never remained active after acceptance`);

      expect(accepted.rejectedBidIds).toEqual([]);
      expect(task.provider).toBe(acceptedProvider.address);
      expect(chosenBid.status).toBe(BidStatus.ACCEPTED);
      expect(stillActiveBid.status).toBe(BidStatus.ACTIVE);
    },
    60_000,
  );

  it(
    'supports bid withdrawal before acceptance and explicit bid rejection',
    async () => {
      const requester = await network.createFundedWallet();
      const withdrawingProvider = await network.createFundedWallet();
      const rejectedProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const withdrawClients = createPhase3Clients(config);
      const rejectClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'withdraw-and-reject');
      const { blobId: withdrawInputBlobId } = await blobStore.store(encoder.encode('withdrawal task'));
      const { blobId: rejectInputBlobId } = await blobStore.store(encoder.encode('rejection task'));

      const withdrawTask = await requesterClients.marketplace.postOpenTask({
        capability: 'market-withdraw',
        category: 'general',
        inputBlobId: withdrawInputBlobId,
        priceMist: 400_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });
      const rejectTask = await requesterClients.marketplace.postOpenTask({
        capability: 'market-reject',
        category: 'general',
        inputBlobId: rejectInputBlobId,
        priceMist: 400_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        signer: requester.keypair,
      });

      const withdrawnBid = await withdrawClients.marketplace.placeBid({
        taskId: withdrawTask.taskId,
        bidPriceMist: 250_000_000n,
        reputationScore: 25n,
        signer: withdrawingProvider.keypair,
      });
      const rejectedBid = await rejectClients.marketplace.placeBid({
        taskId: rejectTask.taskId,
        bidPriceMist: 275_000_000n,
        reputationScore: 30n,
        signer: rejectedProvider.keypair,
      });

      await withdrawClients.marketplace.withdrawBid({ bidId: withdrawnBid.bidId, signer: withdrawingProvider.keypair });
      await requesterClients.marketplace.rejectBid({
        taskId: rejectTask.taskId,
        bidId: rejectedBid.bidId,
        signer: requester.keypair,
      });

      const withdrawn = await waitForBidStatus(requesterClients.marketplace, withdrawnBid.bidId, BidStatus.WITHDRAWN);
      const rejected = await waitForBidStatus(requesterClients.marketplace, rejectedBid.bidId, BidStatus.REJECTED);

      expect(withdrawn.status).toBe(BidStatus.WITHDRAWN);
      expect(rejected.status).toBe(BidStatus.REJECTED);
    },
    60_000,
  );
});
