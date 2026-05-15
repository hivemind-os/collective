import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  PaymentScheme,
  ResultVerifier,
  TaskStatus,
  UsageMeter,
  buildMeteredResultArtifacts,
  createArtifactRoot,
  createBlobStore,
  createNetworkConfig,
  createPhase4Clients,
  encoder,
  findEventByFields,
  getMeteredResultUnits,
  parseMeteredResultEnvelope,
  postMeteredTaskWithBlobStore,
  registerPhase4Agent,
  removeDirectoryWithRetries,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 4 E2E: Metering', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase4-metering');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'executes the full metered lifecycle on local Sui and verifies the result hash chain before refunding the requester delta',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase4Clients(config);
      const providerRegistration = await registerPhase4Agent({
        config,
        wallet: provider,
        capabilityName: 'metered-echo',
        name: 'Metered Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'metering-happy-path');
      const unitPrice = 120_000_000n;
      const maxPrice = 600_000_000n;
      const posted = await postMeteredTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'phase4 metered request',
        capability: 'metered-echo',
        maxPriceMist: maxPrice,
        unitPriceMist: unitPrice,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });

      const openTask = await requesterClients.task.getTask(posted.taskId);
      expect(openTask).toMatchObject({
        id: posted.taskId,
        paymentScheme: PaymentScheme.UPTO,
        maxPrice,
        unitPrice,
      });

      await providerRegistration.clients.task.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.ACCEPTED);

      const resultData = encoder.encode('phase4 metered result payload');
      const { meter, envelopeBytes } = buildMeteredResultArtifacts({
        taskId: posted.taskId,
        resultData,
        maxPrice,
        unitPrice,
        unitChunkSize: 12,
      });
      const { blobId: resultBlobId } = await blobStore.store(envelopeBytes);
      await providerRegistration.clients.task.completeMeteredTask({
        taskId: posted.taskId,
        resultBlobId,
        meteredUnits: meter.getActualUnits(),
        verificationHash: meter.getVerificationHash(),
        providerCardId: providerRegistration.agentCardId,
        keypair: provider.keypair,
      });

      const completedTask = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.COMPLETED);
      const storedResult = await blobStore.fetch(resultBlobId);
      const parsedResult = parseMeteredResultEnvelope(storedResult ?? new Uint8Array());
      const verifier = new ResultVerifier();
      const actualCost = meter.getCost();

      expect(completedTask.paymentScheme).toBe(PaymentScheme.UPTO);
      expect(completedTask.unitPrice).toBe(unitPrice);
      expect(completedTask.maxPrice).toBe(maxPrice);
      expect(completedTask.meteredUnits).toBe(meter.getActualUnits());
      expect(completedTask.verificationHash).toBe(meter.getVerificationHash());
      expect(completedTask.price).toBe(actualCost);
      expect(parsedResult).not.toBeNull();
      expect(verifier.verify(completedTask, parsedResult!.proof, getMeteredResultUnits(parsedResult!))).toBe(true);

      const providerBalanceBeforeRelease = await requesterClients.sui.getBalance(provider.address);
      const requesterBalanceBeforeRelease = await requesterClients.sui.getBalance(requester.address);
      await requesterClients.task.releaseMeteredPayment({ taskId: posted.taskId, keypair: requester.keypair });

      const releasedTask = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.RELEASED);
      const providerBalanceAfterRelease = await requesterClients.sui.getBalance(provider.address);
      const requesterBalanceAfterRelease = await requesterClients.sui.getBalance(requester.address);
      const releasedEvent = await findEventByFields(
        requesterClients.sui,
        `${config.packageId}::task::TaskPaymentReleased`,
        (payload) => payload.task_id === posted.taskId,
      );

      expect(releasedTask.status).toBe(TaskStatus.RELEASED);
      expect(providerBalanceAfterRelease - providerBalanceBeforeRelease).toBe(actualCost);
      expect(BigInt(String(releasedEvent?.refund_amount ?? 0))).toBe(maxPrice - actualCost);
      expect(requesterBalanceAfterRelease).toBeGreaterThan(requesterBalanceBeforeRelease);
    },
    90_000,
  );

  it(
    'caps over-budget usage at max price and fully refunds zero-usage executions',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase4Clients(config);
      const providerRegistration = await registerPhase4Agent({
        config,
        wallet: provider,
        capabilityName: 'metered-edge',
        name: 'Metered Edge Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'metering-edge-cases');

      const cappedPosted = await postMeteredTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'capped case',
        capability: 'metered-edge',
        maxPriceMist: 500_000_000n,
        unitPriceMist: 200_000_000n,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });
      await providerRegistration.clients.task.acceptTask({ taskId: cappedPosted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(requesterClients.task, cappedPosted.taskId, TaskStatus.ACCEPTED);

      const cappedArtifacts = buildMeteredResultArtifacts({
        taskId: cappedPosted.taskId,
        resultData: encoder.encode('this payload burns more units than the max budget permits'),
        maxPrice: 500_000_000n,
        unitPrice: 200_000_000n,
        unitChunkSize: 10,
      });
      const { blobId: cappedResultBlobId } = await blobStore.store(cappedArtifacts.envelopeBytes);
      await providerRegistration.clients.task.completeMeteredTask({
        taskId: cappedPosted.taskId,
        resultBlobId: cappedResultBlobId,
        meteredUnits: cappedArtifacts.meter.getActualUnits(),
        verificationHash: cappedArtifacts.meter.getVerificationHash(),
        keypair: provider.keypair,
      });
      const cappedCompleted = await waitForTaskStatus(requesterClients.task, cappedPosted.taskId, TaskStatus.COMPLETED);
      const providerBalanceBeforeCappedRelease = await requesterClients.sui.getBalance(provider.address);
      await requesterClients.task.releaseMeteredPayment({ taskId: cappedPosted.taskId, keypair: requester.keypair });
      const providerBalanceAfterCappedRelease = await requesterClients.sui.getBalance(provider.address);
      const cappedReleaseEvent = await findEventByFields(
        requesterClients.sui,
        `${config.packageId}::task::TaskPaymentReleased`,
        (payload) => payload.task_id === cappedPosted.taskId,
      );

      expect(cappedCompleted.price).toBe(500_000_000n);
      expect(providerBalanceAfterCappedRelease - providerBalanceBeforeCappedRelease).toBe(500_000_000n);
      expect(BigInt(String(cappedReleaseEvent?.refund_amount ?? 0))).toBe(0n);

      const zeroPosted = await postMeteredTaskWithBlobStore({
        taskClient: requesterClients.task,
        blobStore,
        input: 'zero usage case',
        capability: 'metered-edge',
        maxPriceMist: 400_000_000n,
        unitPriceMist: 100_000_000n,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });
      await providerRegistration.clients.task.acceptTask({ taskId: zeroPosted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(requesterClients.task, zeroPosted.taskId, TaskStatus.ACCEPTED);

      const zeroMeter = new UsageMeter({ taskId: zeroPosted.taskId, maxPrice: 400_000_000n, unitPrice: 100_000_000n });
      const { blobId: zeroResultBlobId } = await blobStore.store(new Uint8Array());
      await providerRegistration.clients.task.completeMeteredTask({
        taskId: zeroPosted.taskId,
        resultBlobId: zeroResultBlobId,
        meteredUnits: 0,
        verificationHash: zeroMeter.getVerificationHash(),
        keypair: provider.keypair,
      });
      const zeroCompleted = await waitForTaskStatus(requesterClients.task, zeroPosted.taskId, TaskStatus.COMPLETED);
      const providerBalanceBeforeZeroRelease = await requesterClients.sui.getBalance(provider.address);
      const requesterBalanceBeforeZeroRelease = await requesterClients.sui.getBalance(requester.address);
      await requesterClients.task.releaseMeteredPayment({ taskId: zeroPosted.taskId, keypair: requester.keypair });
      const providerBalanceAfterZeroRelease = await requesterClients.sui.getBalance(provider.address);
      const requesterBalanceAfterZeroRelease = await requesterClients.sui.getBalance(requester.address);
      const zeroReleaseEvent = await findEventByFields(
        requesterClients.sui,
        `${config.packageId}::task::TaskPaymentReleased`,
        (payload) => payload.task_id === zeroPosted.taskId,
      );

      expect(zeroCompleted.price).toBe(0n);
      expect(providerBalanceAfterZeroRelease - providerBalanceBeforeZeroRelease).toBe(0n);
      expect(BigInt(String(zeroReleaseEvent?.refund_amount ?? 0))).toBe(400_000_000n);
      expect(requesterBalanceAfterZeroRelease).toBeGreaterThan(requesterBalanceBeforeZeroRelease);
    },
    90_000,
  );
});
