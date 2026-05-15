import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  MeshSuiClient,
  TaskClient,
  WalrusBlobStore,
  WalrusBlobTooLargeError,
  parseWalrusBlobReference,
} from '@agentic-mesh/core';
import { TaskStatus } from '@agentic-mesh/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockWalrusServer, PortAllocator, SuiTestNetwork } from '../harness/index.js';
import {
  buildEchoResult,
  createArtifactRoot,
  createNetworkConfig,
  defaultDisputeWindowMs,
  defaultPriceMist,
  removeDirectoryWithRetries,
  waitForTaskStatus,
} from './test-helpers.js';

const encoder = new TextEncoder();
const walrusPublisherUrl = process.env.WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL;
const walrusAggregatorUrl = process.env.WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL;
const walrusEpochs = Number(process.env.WALRUS_EPOCHS ?? '5');
const runWalrusTestnet = process.env.RUN_WALRUS_TESTNET === '1';

let artifactRoot: string;
let network: SuiTestNetwork;

beforeAll(async () => {
  artifactRoot = await createArtifactRoot('walrus-lifecycle');
  network = new SuiTestNetwork();
  await network.start();
}, 120_000);

afterAll(async () => {
  await network?.stop();
  await removeDirectoryWithRetries(artifactRoot);
}, 30_000);

describe('Phase 1 Beta E2E: Walrus lifecycle', () => {
  it('runs the full task lifecycle with mock Walrus blobs and verifies content integrity', async () => {
    const walrus = await startMockWalrus();

    try {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const networkConfig = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
      const providerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
      const consumerBlobStore = walrus.createStore();
      const providerBlobStore = walrus.createStore();
      const resultBlobStore = walrus.createStore();
      const inputData = encoder.encode(`walrus-mock-task-${randomUUID()}`);

      const storedInput = await consumerBlobStore.store(inputData);
      expect(storedInput.hash).toBe(sha256(inputData));
      expect(walrus.server.hasBlob(parseWalrusBlobReference(storedInput.blobId).storageBlobId)).toBe(true);

      const { taskId } = await consumerTaskClient.postTask({
        capability: 'echo',
        category: 'general',
        inputBlobId: storedInput.blobId,
        priceMist: defaultPriceMist,
        disputeWindowMs: defaultDisputeWindowMs,
        expiryHours: 1,
        keypair: consumer.keypair,
      });

      await providerTaskClient.acceptTask({ taskId, keypair: provider.keypair });
      await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.ACCEPTED);

      const providerInput = await providerBlobStore.fetch(storedInput.blobId);
      expect(providerInput).not.toBeNull();
      expect(sha256(providerInput ?? new Uint8Array())).toBe(storedInput.hash);

      const resultData = buildEchoResult(taskId, 'echo', providerInput ?? new Uint8Array());
      const storedResult = await resultBlobStore.store(resultData);
      await providerTaskClient.completeTask({
        taskId,
        resultBlobId: storedResult.blobId,
        keypair: provider.keypair,
      });

      const completedTask = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.COMPLETED);
      const fetchedResult = await walrus.createStore().fetch(completedTask.resultBlobId ?? '');

      expect(completedTask.resultBlobId).toBe(storedResult.blobId);
      expect(sha256(fetchedResult ?? new Uint8Array())).toBe(storedResult.hash);

      await consumerTaskClient.releasePayment({ taskId, keypair: consumer.keypair });
      const released = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.RELEASED);
      const counts = walrus.server.getRequestCounts();

      expect(released.resultBlobId).toBe(storedResult.blobId);
      expect(counts.put).toBeGreaterThanOrEqual(2);
      expect(counts.get).toBeGreaterThanOrEqual(2);
    } finally {
      await walrus.cleanup();
    }
  }, 60_000);

  it('handles a 1MB blob through the Walrus-backed task flow', async () => {
    const walrus = await startMockWalrus();

    try {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const networkConfig = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
      const providerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
      const blobStore = walrus.createStore();
      const inputData = randomBytes(1024 * 1024);

      const storedInput = await blobStore.store(inputData);
      const { taskId } = await consumerTaskClient.postTask({
        capability: 'echo-large',
        category: 'general',
        inputBlobId: storedInput.blobId,
        priceMist: defaultPriceMist,
        disputeWindowMs: defaultDisputeWindowMs,
        expiryHours: 1,
        keypair: consumer.keypair,
      });

      await providerTaskClient.acceptTask({ taskId, keypair: provider.keypair });
      await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.ACCEPTED);

      const fetchedInput = await blobStore.fetch(storedInput.blobId);
      expect(Buffer.from(fetchedInput ?? [])).toEqual(Buffer.from(inputData));

      const result = encoder.encode(JSON.stringify({ taskId, inputHash: sha256(fetchedInput ?? new Uint8Array()) }));
      const storedResult = await blobStore.store(result);
      await providerTaskClient.completeTask({ taskId, resultBlobId: storedResult.blobId, keypair: provider.keypair });

      const completed = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.COMPLETED);
      expect(completed.resultBlobId).toBe(storedResult.blobId);
    } finally {
      await walrus.cleanup();
    }
  }, 60_000);

  it('rejects oversized blobs before upload when the Walrus size limit is exceeded', async () => {
    const walrus = await startMockWalrus();

    try {
      const blobStore = walrus.createStore({ maxBlobSize: 1024 });

      await expect(blobStore.store(randomBytes(1025))).rejects.toBeInstanceOf(WalrusBlobTooLargeError);
      expect(walrus.server.getRequestCounts().put).toBe(0);
    } finally {
      await walrus.cleanup();
    }
  });

  const maybeIt = runWalrusTestnet ? it : it.skip;
  maybeIt('runs the full lifecycle against Walrus Testnet when enabled', async () => {
    const consumer = await network.createFundedWallet();
    const provider = await network.createFundedWallet();
    const networkConfig = createNetworkConfig(network);
    const consumerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
    const providerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
    const consumerBlobStore = createWalrusTestnetStore();
    const providerBlobStore = createWalrusTestnetStore();
    const resultBlobStore = createWalrusTestnetStore();
    const inputData = encoder.encode(`walrus-testnet-${randomUUID()}`);

    const storedInput = await consumerBlobStore.store(inputData);
    const { taskId } = await consumerTaskClient.postTask({
      capability: 'echo',
      category: 'general',
      inputBlobId: storedInput.blobId,
      priceMist: defaultPriceMist,
      disputeWindowMs: defaultDisputeWindowMs,
      expiryHours: 1,
      keypair: consumer.keypair,
    });

    await providerTaskClient.acceptTask({ taskId, keypair: provider.keypair });
    await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.ACCEPTED);

    const providerInput = await providerBlobStore.fetch(storedInput.blobId);
    expect(Buffer.from(providerInput ?? [])).toEqual(Buffer.from(inputData));

    const resultData = buildEchoResult(taskId, 'echo', providerInput ?? new Uint8Array());
    const storedResult = await resultBlobStore.store(resultData);
    await providerTaskClient.completeTask({ taskId, resultBlobId: storedResult.blobId, keypair: provider.keypair });

    const completed = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.COMPLETED);
    const fetchedResult = await createWalrusTestnetStore().fetch(completed.resultBlobId ?? '');

    expect(completed.resultBlobId).toBe(storedResult.blobId);
    expect(Buffer.from(fetchedResult ?? [])).toEqual(Buffer.from(resultData));
  }, 240_000);
});

function createWalrusTestnetStore(): WalrusBlobStore {
  return new WalrusBlobStore({
    publisherUrl: walrusPublisherUrl,
    aggregatorUrl: walrusAggregatorUrl,
    epochs: walrusEpochs,
    timeoutMs: 120_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
  });
}

async function startMockWalrus() {
  const portAllocator = new PortAllocator();
  const [port] = await portAllocator.allocate(1);
  const server = new MockWalrusServer();
  await server.start(port);

  return {
    server,
    createStore: (overrides: Partial<ConstructorParameters<typeof WalrusBlobStore>[0]> = {}) =>
      new WalrusBlobStore({
        publisherUrl: server.publisherUrl,
        aggregatorUrl: server.aggregatorUrl,
        epochs: 5,
        timeoutMs: 10_000,
        retryAttempts: 2,
        retryDelayMs: 50,
        ...overrides,
      }),
    cleanup: async () => {
      await server.stop();
      await portAllocator.release([port]);
    },
  };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
