import { randomUUID } from 'node:crypto';

import { FilesystemBlobStore, MeshSuiClient, TaskClient } from '@agentic-mesh/core';
import { TaskStatus } from '@agentic-mesh/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  buildEchoResult,
  createArtifactDir,
  createArtifactRoot,
  createNetworkConfig,
  defaultDisputeWindowMs,
  delay,
  defaultPriceMist,
  parseJson,
  postTaskWithBlobStore,
  removeDirectoryWithRetries,
  waitForTaskStatus,
} from './test-helpers.js';

const testTimeoutMs = 60_000;

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 1 E2E: Task lifecycle', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('task-lifecycle');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'tracks status transitions, escrow, blob ids, and provider payment through the full happy path',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerSui = new MeshSuiClient(config);
      const providerSui = new MeshSuiClient(config);
      const consumerTaskClient = new TaskClient(consumerSui, config);
      const providerTaskClient = new TaskClient(providerSui, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'happy-path'));
      const priceMist = 250_000_000n;
      const agreementHash = `agreement-${randomUUID()}`;

      const providerBalanceBeforeRelease = await providerSui.getBalance(provider.address);
      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'Phase 1 happy path payload',
        capability: 'echo',
        agreementHash,
        priceMist,
        disputeWindowMs: defaultDisputeWindowMs,
        expiryHours: 1,
        keypair: consumer.keypair,
      });

      const openTask = await consumerTaskClient.getTask(posted.taskId);
      expect(openTask).toMatchObject({
        id: posted.taskId,
        requester: consumer.address,
        capability: 'echo',
        inputBlobId: posted.inputBlobId,
        agreementHash,
        price: priceMist,
        status: TaskStatus.OPEN,
      });
      expect(openTask?.provider).toBeUndefined();

      await providerTaskClient.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      const acceptedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);
      expect(acceptedTask.provider).toBe(provider.address);
      expect(acceptedTask.acceptedAt).toBeGreaterThanOrEqual(acceptedTask.createdAt);
      expect(acceptedTask.price).toBe(priceMist);

      const resultPayload = buildEchoResult(posted.taskId, 'echo', posted.inputData);
      const { blobId: resultBlobId } = await blobStore.store(resultPayload);
      await providerTaskClient.completeTask({
        taskId: posted.taskId,
        resultBlobId,
        keypair: provider.keypair,
      });

      const completedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.COMPLETED);
      expect(completedTask.resultBlobId).toBe(resultBlobId);
      expect(completedTask.completedAt).toBeGreaterThanOrEqual(completedTask.acceptedAt ?? 0);

      const providerBalanceAfterComplete = await providerSui.getBalance(provider.address);
      await consumerTaskClient.releasePayment({ taskId: posted.taskId, keypair: consumer.keypair });

      const releasedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.RELEASED);
      const providerBalanceAfterRelease = await providerSui.getBalance(provider.address);
      const persistedResult = await blobStore.fetch(resultBlobId);
      const parsedResult = parseJson<{ echo: string; taskId: string; capability: string }>(persistedResult ?? new Uint8Array());

      expect(releasedTask.resultBlobId).toBe(resultBlobId);
      expect(providerBalanceAfterRelease).toBeGreaterThan(providerBalanceBeforeRelease);
      expect(providerBalanceAfterRelease - providerBalanceAfterComplete).toBe(priceMist);
      expect(parsedResult).toMatchObject({
        echo: 'Phase 1 happy path payload',
        taskId: posted.taskId,
        capability: 'echo',
      });
    },
    testTimeoutMs,
  );

  it(
    'cancels an open task before acceptance and returns the escrow to the consumer',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerSui = new MeshSuiClient(config);
      const taskClient = new TaskClient(consumerSui, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'cancel-before-accept'));
      const balanceBeforePost = await consumerSui.getBalance(consumer.address);

      const posted = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'cancel me before anyone accepts',
        capability: 'no-provider',
        priceMist: defaultPriceMist,
        keypair: consumer.keypair,
      });
      const balanceAfterPost = await consumerSui.getBalance(consumer.address);

      await taskClient.cancelTask({ taskId: posted.taskId, keypair: consumer.keypair });

      const cancelledTask = await waitForTaskStatus(taskClient, posted.taskId, TaskStatus.CANCELLED);
      const balanceAfterCancel = await consumerSui.getBalance(consumer.address);

      expect(cancelledTask.status).toBe(TaskStatus.CANCELLED);
      expect(cancelledTask.price).toBe(defaultPriceMist);
      expect(balanceAfterPost).toBeLessThan(balanceBeforePost);
      expect(balanceAfterCancel).toBeGreaterThan(balanceAfterPost);
      expect(balanceAfterCancel).toBeGreaterThan(balanceBeforePost - 20_000_000n);
    },
    testTimeoutMs,
  );

  it(
    'allows only the original poster to cancel a task',
    async () => {
      const consumer = await network.createFundedWallet();
      const stranger = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const strangerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'cancel-owner-only'));

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'only the requester can cancel this',
        capability: 'restricted-cancel',
        keypair: consumer.keypair,
      });

      await expect(strangerTaskClient.cancelTask({ taskId: posted.taskId, keypair: stranger.keypair })).rejects.toThrow();

      const task = await consumerTaskClient.getTask(posted.taskId);
      expect(task?.status).toBe(TaskStatus.OPEN);
      expect(task?.price).toBe(defaultPriceMist);
    },
    testTimeoutMs,
  );

  it(
    'refunds expired open tasks without sending the refund to the caller',
    async () => {
      const consumer = await network.createFundedWallet();
      const refundCaller = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerSui = new MeshSuiClient(config);
      const consumerTaskClient = new TaskClient(consumerSui, config);
      const refundClient = new TaskClient(new MeshSuiClient(config), config);
      const refundCallerSui = new MeshSuiClient(config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'expired-refund'));
      const consumerBalanceBeforePost = await consumerSui.getBalance(consumer.address);
      const callerBalanceBeforeRefund = await refundCallerSui.getBalance(refundCaller.address);

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'this task will expire immediately',
        capability: 'expired-task',
        priceMist: 175_000_000n,
        expiryHours: 0,
        keypair: consumer.keypair,
      });

      await delay(1_000);
      await refundClient.refundExpiredTask({ taskId: posted.taskId, keypair: refundCaller.keypair });

      const refundedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.CANCELLED);
      const consumerBalanceAfterRefund = await consumerSui.getBalance(consumer.address);
      const callerBalanceAfterRefund = await refundCallerSui.getBalance(refundCaller.address);

      expect(refundedTask.status).toBe(TaskStatus.CANCELLED);
      expect(refundedTask.price).toBe(175_000_000n);
      expect(consumerBalanceAfterRefund).toBeGreaterThan(consumerBalanceBeforePost - 20_000_000n);
      expect(callerBalanceAfterRefund - callerBalanceBeforeRefund).toBeLessThan(10_000_000n);
    },
    testTimeoutMs,
  );

  it(
    'supports multiple open tasks from the same consumer at the same time',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const taskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'parallel-open-tasks'));

      const first = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'task one',
        capability: 'parallel-consumer',
        keypair: consumer.keypair,
      });
      const second = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'task two',
        capability: 'parallel-consumer',
        keypair: consumer.keypair,
      });
      const third = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'task three',
        capability: 'parallel-consumer',
        keypair: consumer.keypair,
      });

      const tasks = await Promise.all([
        taskClient.getTask(first.taskId),
        taskClient.getTask(second.taskId),
        taskClient.getTask(third.taskId),
      ]);

      expect(new Set(tasks.map((task) => task?.id))).toEqual(new Set([first.taskId, second.taskId, third.taskId]));
      expect(tasks.every((task) => task?.requester === consumer.address && task.status === TaskStatus.OPEN)).toBe(true);
    },
    testTimeoutMs,
  );

  it(
    'allows multiple providers to accept different tasks in parallel',
    async () => {
      const consumer = await network.createFundedWallet();
      const firstProvider = await network.createFundedWallet();
      const secondProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const firstProviderTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const secondProviderTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'parallel-provider-accepts'));

      const first = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'first task',
        capability: 'parallel-providers',
        keypair: consumer.keypair,
      });
      const second = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'second task',
        capability: 'parallel-providers',
        keypair: consumer.keypair,
      });

      await Promise.all([
        firstProviderTaskClient.acceptTask({ taskId: first.taskId, keypair: firstProvider.keypair }),
        secondProviderTaskClient.acceptTask({ taskId: second.taskId, keypair: secondProvider.keypair }),
      ]);

      const [firstAccepted, secondAccepted] = await Promise.all([
        waitForTaskStatus(consumerTaskClient, first.taskId, TaskStatus.ACCEPTED),
        waitForTaskStatus(consumerTaskClient, second.taskId, TaskStatus.ACCEPTED),
      ]);

      expect(firstAccepted.provider).toBe(firstProvider.address);
      expect(secondAccepted.provider).toBe(secondProvider.address);
      expect(firstAccepted.provider).not.toBe(secondAccepted.provider);
    },
    testTimeoutMs,
  );

  it(
    'does not allow the consumer to release payment before the task is completed',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const providerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'release-before-complete'));

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'not completed yet',
        capability: 'release-guard',
        keypair: consumer.keypair,
      });
      await providerTaskClient.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);

      await expect(consumerTaskClient.releasePayment({ taskId: posted.taskId, keypair: consumer.keypair })).rejects.toThrow();

      const task = await consumerTaskClient.getTask(posted.taskId);
      expect(task?.status).toBe(TaskStatus.ACCEPTED);
      expect(task?.price).toBe(defaultPriceMist);
    },
    testTimeoutMs,
  );

  it(
    "does not allow a provider who didn't accept the task to complete it",
    async () => {
      const consumer = await network.createFundedWallet();
      const acceptingProvider = await network.createFundedWallet();
      const otherProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const acceptingTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const otherTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'wrong-provider-complete'));

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'only the accepted provider can complete this',
        capability: 'complete-guard',
        keypair: consumer.keypair,
      });
      await acceptingTaskClient.acceptTask({ taskId: posted.taskId, keypair: acceptingProvider.keypair });
      const acceptedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);
      const { blobId: resultBlobId } = await blobStore.store(buildEchoResult(posted.taskId, 'complete-guard', posted.inputData));

      await expect(
        otherTaskClient.completeTask({
          taskId: posted.taskId,
          resultBlobId,
          keypair: otherProvider.keypair,
        }),
      ).rejects.toThrow();

      const taskAfterFailure = await consumerTaskClient.getTask(posted.taskId);
      expect(taskAfterFailure?.status).toBe(TaskStatus.ACCEPTED);
      expect(taskAfterFailure?.provider).toBe(acceptedTask.provider);
      expect(taskAfterFailure?.resultBlobId).toBeUndefined();
    },
    testTimeoutMs,
  );

  it(
    'stores the exact posted price on-chain for each escrowed task',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerSui = new MeshSuiClient(config);
      const taskClient = new TaskClient(consumerSui, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'escrow-amounts'));

      const prices = [50_000_000n, 125_000_000n, 375_000_000n];
      const postedTasks = [] as Array<{ taskId: string; priceMist: bigint }>;
      for (const priceMist of prices) {
        const posted = await postTaskWithBlobStore({
          taskClient,
          blobStore,
          input: `price-${priceMist.toString()}`,
          capability: 'escrow-check',
          priceMist,
          keypair: consumer.keypair,
        });
        postedTasks.push({ taskId: posted.taskId, priceMist });
      }

      const storedPrices = await Promise.all(
        postedTasks.map(async (task) => {
          const storedTask = await taskClient.getTask(task.taskId);
          return storedTask?.price;
        }),
      );
      expect(storedPrices).toEqual(prices);
    },
    testTimeoutMs,
  );
});
