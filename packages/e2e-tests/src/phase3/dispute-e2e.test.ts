import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  DisputeStatus,
  TaskStatus,
  buildEchoResult,
  createBlobStore,
  createNetworkConfig,
  createPhase3Clients,
  createArtifactRoot,
  postTaskWithBlobStore,
  removeDirectoryWithRetries,
  waitForCondition,
  waitForDisputeStatus,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

async function acceptAndCompleteTask(params: {
  requesterTaskClient: ReturnType<typeof createPhase3Clients>['task'];
  providerTaskClient: ReturnType<typeof createPhase3Clients>['task'];
  blobStore: Awaited<ReturnType<typeof createBlobStore>>;
  taskId: string;
  inputData: Uint8Array;
  providerKeypair: Ed25519Keypair;
}) {
  await params.providerTaskClient.acceptTask({ taskId: params.taskId, keypair: params.providerKeypair });
  await waitForTaskStatus(params.requesterTaskClient, params.taskId, TaskStatus.ACCEPTED);
  const { blobId: resultBlobId } = await params.blobStore.store(buildEchoResult(params.taskId, 'disputed-capability', params.inputData));
  await params.providerTaskClient.completeTask({ taskId: params.taskId, resultBlobId, keypair: params.providerKeypair });
  await waitForTaskStatus(params.requesterTaskClient, params.taskId, TaskStatus.COMPLETED);
  return resultBlobId;
}

describe('Phase 3 E2E: Dispute resolution', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-dispute');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'runs the full mutual-resolution lifecycle and splits escrow between requester and provider',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const providerClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'mutual-resolution');
      const priceMist = 500_000_000n;
      const requesterShare = 200_000_000n;

      const posted = await postTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'mutual-resolution-input',
        capability: 'disputed-capability',
        priceMist,
        disputeWindowMs: 60_000,
        keypair: requester.keypair,
      });

      await acceptAndCompleteTask({
        requesterTaskClient: requesterClients.task,
        providerTaskClient: providerClients.task,
        blobStore,
        taskId: posted.taskId,
        inputData: posted.inputData,
        providerKeypair: provider.keypair,
      });

      const { blobId: requesterEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('requester evidence'));
      const { blobId: providerEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('provider evidence'));

      const opened = await requesterClients.dispute.openDispute({
        taskId: posted.taskId,
        evidenceBlobId: requesterEvidenceBlobId,
        proposedSplitMist: requesterShare,
        signer: requester.keypair,
      });
      await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.DISPUTED);
      await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.OPEN);

      await providerClients.dispute.respondToDispute({
        disputeId: opened.disputeId,
        evidenceBlobId: providerEvidenceBlobId,
        proposedSplitMist: requesterShare,
        signer: provider.keypair,
      });
      await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.RESPONDED);
      const requesterBalanceBefore = await requesterClients.sui.getBalance(requester.address);
      const providerBalanceBefore = await providerClients.sui.getBalance(provider.address);

      const resolved = await providerClients.dispute.acceptResolution({
        disputeId: opened.disputeId,
        taskId: posted.taskId,
        signer: provider.keypair,
      });
      const requesterBalanceAfter = await requesterClients.sui.getBalance(requester.address);
      const providerBalanceAfter = await providerClients.sui.getBalance(provider.address);
      const dispute = await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.MUTUAL_RESOLVED);
      const task = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.RELEASED);

      expect(resolved.requesterAmount).toBe(requesterShare);
      expect(resolved.providerAmount).toBe(priceMist - requesterShare);
      expect(requesterBalanceAfter - requesterBalanceBefore).toBe(requesterShare);
      expect(providerBalanceAfter).toBeGreaterThan(providerBalanceBefore);
      expect(dispute.providerProposedSplit).toBe(requesterShare);
      expect(task.status).toBe(TaskStatus.RELEASED);
    },
    60_000,
  );

  it(
    'supports arbitration and exact escrow splitting by an arbitrator account',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const arbitrator = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const providerClients = createPhase3Clients(config);
      const arbitratorClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'arbitrated-resolution');
      const priceMist = 600_000_000n;
      const requesterShare = 250_000_000n;

      const posted = await postTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'arbitrated-input',
        capability: 'disputed-capability',
        priceMist,
        disputeWindowMs: 60_000,
        keypair: requester.keypair,
      });

      await acceptAndCompleteTask({
        requesterTaskClient: requesterClients.task,
        providerTaskClient: providerClients.task,
        blobStore,
        taskId: posted.taskId,
        inputData: posted.inputData,
        providerKeypair: provider.keypair,
      });

      const { blobId: requesterEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('requester evidence'));
      const { blobId: providerEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('provider evidence'));

      const opened = await requesterClients.dispute.openDispute({
        taskId: posted.taskId,
        evidenceBlobId: requesterEvidenceBlobId,
        proposedSplitMist: 300_000_000n,
        arbitratorAddress: arbitrator.address,
        signer: requester.keypair,
      });
      await providerClients.dispute.respondToDispute({
        disputeId: opened.disputeId,
        evidenceBlobId: providerEvidenceBlobId,
        proposedSplitMist: 100_000_000n,
        signer: provider.keypair,
      });
      await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.RESPONDED);
      const requesterBalanceBefore = await requesterClients.sui.getBalance(requester.address);
      const providerBalanceBefore = await providerClients.sui.getBalance(provider.address);

      await arbitratorClients.dispute.arbitrate({
        disputeId: opened.disputeId,
        taskId: posted.taskId,
        rulingSplitMist: requesterShare,
        signer: arbitrator.keypair,
      });

      const requesterBalanceAfter = await requesterClients.sui.getBalance(requester.address);
      const providerBalanceAfter = await providerClients.sui.getBalance(provider.address);
      const dispute = await waitForDisputeStatus(requesterClients.dispute, opened.disputeId, DisputeStatus.ARBITRATED);
      const task = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.RELEASED);

      expect(dispute.rulingSplit).toBe(requesterShare);
      expect(requesterBalanceAfter - requesterBalanceBefore).toBe(requesterShare);
      expect(providerBalanceAfter - providerBalanceBefore).toBe(priceMist - requesterShare);
      expect(task.status).toBe(TaskStatus.RELEASED);
    },
    60_000,
  );

  it(
    'rejects disputes opened after the configured dispute window expires',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const providerClients = createPhase3Clients(config);
      const blobStore = await createBlobStore(artifactRoot, 'expired-window');

      const posted = await postTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'expired-dispute-window',
        capability: 'disputed-capability',
        priceMist: 200_000_000n,
        disputeWindowMs: 100,
        keypair: requester.keypair,
      });

      await acceptAndCompleteTask({
        requesterTaskClient: requesterClients.task,
        providerTaskClient: providerClients.task,
        blobStore,
        taskId: posted.taskId,
        inputData: posted.inputData,
        providerKeypair: provider.keypair,
      });

      const completedTask = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.COMPLETED);
      await waitForCondition(
        async () => Date.now() >= (completedTask.completedAt ?? 0) + 150 ? true : undefined,
        5_000,
        'Dispute window did not expire before attempting to open the dispute',
      );

      const { blobId: requesterEvidenceBlobId } = await blobStore.store(new TextEncoder().encode('late evidence'));

      await expect(
        requesterClients.dispute.openDispute({
          taskId: posted.taskId,
          evidenceBlobId: requesterEvidenceBlobId,
          proposedSplitMist: 100_000_000n,
          signer: requester.keypair,
        }),
      ).rejects.toThrow();
    },
    60_000,
  );
});
