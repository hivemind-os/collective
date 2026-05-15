import { randomUUID } from 'node:crypto';

import {
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  MeshSuiClient,
  TaskClient,
  WalrusBlobStore,
} from '@agentic-mesh/core';
import { TaskStatus } from '@agentic-mesh/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  buildEchoResult,
  createArtifactRoot,
  createNetworkConfig,
  defaultDisputeWindowMs,
  defaultPriceMist,
  removeDirectoryWithRetries,
  waitForTaskStatus,
} from './test-helpers.js';

const runWalrusTestnet = process.env.RUN_WALRUS_TESTNET === '1';
const describeWalrus = runWalrusTestnet ? describe : describe.skip;
const walrusPublisherUrl = process.env.WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL;
const walrusAggregatorUrl = process.env.WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL;
const walrusEpochs = Number(process.env.WALRUS_EPOCHS ?? '5');

let artifactRoot: string;
let network: SuiTestNetwork;

function createWalrusStore(): WalrusBlobStore {
  return new WalrusBlobStore({
    publisherUrl: walrusPublisherUrl,
    aggregatorUrl: walrusAggregatorUrl,
    epochs: walrusEpochs,
    timeoutMs: 120_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
  });
}

describeWalrus('Phase 1 E2E: Walrus', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('walrus');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it('stores and fetches a blob through Walrus Testnet', async () => {
    const store = createWalrusStore();
    const data = new TextEncoder().encode(`walrus-roundtrip-${randomUUID()}`);

    const stored = await store.store(data);
    const fetched = await createWalrusStore().fetch(stored.blobId);

    expect(stored.blobId).toMatch(/^walrus:[A-Za-z0-9_-]{43}:[a-f0-9]{64}$/);
    expect(stored.hash).toHaveLength(64);
    expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(data));
  }, 180_000);

  it('runs the full task payload lifecycle with Walrus blob references', async () => {
    const consumer = await network.createFundedWallet();
    const provider = await network.createFundedWallet();
    const networkConfig = createNetworkConfig(network);
    const consumerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
    const providerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
    const consumerBlobStore = createWalrusStore();
    const providerBlobStore = createWalrusStore();
    const resultBlobStore = createWalrusStore();
    const inputData = new TextEncoder().encode(`walrus-task-${randomUUID()}`);

    const storedInput = await consumerBlobStore.store(inputData);
    const posted = await consumerTaskClient.postTask({
      capability: 'echo',
      category: 'general',
      inputBlobId: storedInput.blobId,
      priceMist: defaultPriceMist,
      disputeWindowMs: defaultDisputeWindowMs,
      expiryHours: 1,
      keypair: consumer.keypair,
    });

    const openTask = await consumerTaskClient.getTask(posted.taskId);
    expect(openTask?.inputBlobId).toBe(storedInput.blobId);

    await providerTaskClient.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
    await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);

    const providerInput = await providerBlobStore.fetch(storedInput.blobId);
    expect(Buffer.from(providerInput ?? [])).toEqual(Buffer.from(inputData));

    const resultData = buildEchoResult(posted.taskId, 'echo', providerInput ?? new Uint8Array());
    const storedResult = await resultBlobStore.store(resultData);
    await providerTaskClient.completeTask({
      taskId: posted.taskId,
      resultBlobId: storedResult.blobId,
      keypair: provider.keypair,
    });

    const completedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.COMPLETED);
    expect(completedTask.resultBlobId).toBe(storedResult.blobId);

    const fetchedResult = await createWalrusStore().fetch(completedTask.resultBlobId ?? '');
    expect(Buffer.from(fetchedResult ?? [])).toEqual(Buffer.from(resultData));

    await consumerTaskClient.releasePayment({ taskId: posted.taskId, keypair: consumer.keypair });
    const releasedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.RELEASED);
    expect(releasedTask.resultBlobId).toBe(storedResult.blobId);
  }, 240_000);
});
