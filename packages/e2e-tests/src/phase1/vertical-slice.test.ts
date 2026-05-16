import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  EventSubscription,
  FilesystemBlobStore,
  MeshSuiClient,
  parseRawEvent,
  RegistryClient,
  SqliteCursorStore,
  TaskClient,
} from '@hivemind-os/collective-core';
import { PaymentRail, TaskStatus, type NetworkConfig } from '@hivemind-os/collective-types';
import type { SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EVENT_TIMEOUT, SuiTestNetwork } from '../harness/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const artifactRoot = resolve(process.cwd(), '.artifacts', `vertical-slice-${randomUUID()}`);
const echoPriceMist = 100_000_000n;
const disputeWindowMs = 3_600_000;
const expiryHours = 1;
const pollIntervalMs = 500;

let network: SuiTestNetwork;

interface EventDrivenProviderHandle {
  stop(): Promise<void>;
}

describe('Vertical Slice: Full Task Lifecycle', () => {
  beforeAll(async () => {
    await mkdir(artifactRoot, { recursive: true });
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'should complete a full task lifecycle: register → discover → post → accept → complete → release',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig();

      const consumerSui = new MeshSuiClient(config);
      const providerSui = new MeshSuiClient(config);
      const consumerRegistryClient = new RegistryClient(consumerSui, config);
      const providerRegistryClient = new RegistryClient(providerSui, config);
      const consumerTaskClient = new TaskClient(consumerSui, config);
      const providerTaskClient = new TaskClient(providerSui, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir('blobs-lifecycle'));

      const providerDid = createTestDid('provider');
      const { agentCardId } = await providerRegistryClient.registerAgent({
        name: 'Echo Provider',
        did: providerDid,
        description: 'Test echo provider',
        capabilities: [createEchoCapability()],
        endpoint: 'mesh://provider/echo',
        keypair: provider.keypair,
      });
      expect(agentCardId).toBeTruthy();

      const discoveredAgents = await waitForCondition(async () => {
        const agents = await consumerRegistryClient.discoverByCapability('echo');
        return agents.some((agent) => agent.id === agentCardId) ? agents : undefined;
      }, EVENT_TIMEOUT, 'Registered provider was not discoverable by capability');
      expect(discoveredAgents.some((agent) => agent.did === providerDid)).toBe(true);

      const inputData = encoder.encode('Hello, Agentic Mesh!');
      const { blobId: inputBlobId } = await blobStore.store(inputData);

      const { taskId } = await consumerTaskClient.postTask({
        capability: 'echo',
        category: 'general',
        inputBlobId,
        priceMist: echoPriceMist,
        disputeWindowMs,
        expiryHours,
        keypair: consumer.keypair,
      });
      expect(taskId).toBeTruthy();

      await providerTaskClient.acceptTask({
        taskId,
        keypair: provider.keypair,
      });
      const acceptedTask = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.ACCEPTED);
      expect(acceptedTask.provider).toBe(provider.address);

      const { blobId: resultBlobId } = await blobStore.store(buildEchoResult(taskId, 'echo', inputData));

      await providerTaskClient.completeTask({
        taskId,
        resultBlobId,
        keypair: provider.keypair,
      });
      await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.COMPLETED);

      await consumerTaskClient.releasePayment({
        taskId,
        keypair: consumer.keypair,
      });
      const finalTask = await waitForTaskStatus(consumerTaskClient, taskId, TaskStatus.RELEASED);

      expect(finalTask.resultBlobId).toBe(resultBlobId);
      expect(finalTask.provider).toBe(provider.address);

      const resultData = await blobStore.fetch(resultBlobId);
      expect(resultData).toBeTruthy();
      const result = JSON.parse(decoder.decode(resultData ?? new Uint8Array())) as Record<string, unknown>;
      expect(result.echo).toBe('Hello, Agentic Mesh!');
      expect(result.capability).toBe('echo');
      expect(result.taskId).toBe(taskId);
    },
    120_000,
  );

  it('should handle task cancellation with full refund', async () => {
    const consumer = await network.createFundedWallet();
    const config = createNetworkConfig();
    const consumerSui = new MeshSuiClient(config);
    const taskClient = new TaskClient(consumerSui, config);
    const blobStore = new FilesystemBlobStore(await createArtifactDir('blobs-cancel'));

    const balanceBefore = await consumerSui.getBalance(consumer.address);
    const { blobId: inputBlobId } = await blobStore.store(encoder.encode('cancel me'));

    const { taskId } = await taskClient.postTask({
      capability: 'nonexistent',
      category: 'general',
      inputBlobId,
      priceMist: 50_000_000n,
      disputeWindowMs,
      expiryHours,
      keypair: consumer.keypair,
    });

    const balanceAfterPost = await consumerSui.getBalance(consumer.address);
    expect(balanceAfterPost).toBeLessThan(balanceBefore);

    await taskClient.cancelTask({ taskId, keypair: consumer.keypair });

    const cancelledTask = await waitForTaskStatus(taskClient, taskId, TaskStatus.CANCELLED);
    const balanceAfterCancel = await consumerSui.getBalance(consumer.address);

    expect(cancelledTask.status).toBe(TaskStatus.CANCELLED);
    expect(balanceAfterCancel).toBeGreaterThan(balanceAfterPost);
    expect(balanceAfterCancel).toBeGreaterThan(balanceBefore - 10_000_000n);
  }, 60_000);

  it('should handle event-driven provider flow', async () => {
    const consumer = await network.createFundedWallet();
    const provider = await network.createFundedWallet();
    const config = createNetworkConfig();

    const consumerSui = new MeshSuiClient(config);
    const providerSui = new MeshSuiClient(config);
    const consumerRegistryClient = new RegistryClient(consumerSui, config);
    const providerRegistryClient = new RegistryClient(providerSui, config);
    const consumerTaskClient = new TaskClient(consumerSui, config);
    const blobStore = new FilesystemBlobStore(await createArtifactDir('blobs-events'));

    const providerDid = createTestDid('event-provider');
    const { agentCardId } = await providerRegistryClient.registerAgent({
      name: 'Event-Driven Echo Provider',
      did: providerDid,
      description: 'Processes TaskPosted events with the echo capability',
      capabilities: [createEchoCapability()],
      endpoint: 'mesh://provider/event-echo',
      keypair: provider.keypair,
    });

    await waitForCondition(async () => {
      const agents = await consumerRegistryClient.discoverByCapability('echo');
      return agents.some((agent) => agent.id === agentCardId) ? agents : undefined;
    }, EVENT_TIMEOUT, 'Event-driven provider registration was not discoverable');

    const cursorDbPath = join(await createArtifactDir('event-provider'), 'provider-cursors.sqlite');
    const processedTaskIds: string[] = [];

    const firstProviderRun = await startEventDrivenEchoProvider({
      config,
      blobStore,
      cursorDbPath,
      providerKeypair: provider.keypair,
      processedTaskIds,
    });

    const firstTask = await postTaskWithBlobStore({
      taskClient: consumerTaskClient,
      blobStore,
      input: 'Event driven task #1',
      keypair: consumer.keypair,
    });
    await waitForTaskStatus(consumerTaskClient, firstTask.taskId, TaskStatus.COMPLETED, EVENT_TIMEOUT + 15_000);
    await consumerTaskClient.releasePayment({ taskId: firstTask.taskId, keypair: consumer.keypair });
    const firstReleasedTask = await waitForTaskStatus(consumerTaskClient, firstTask.taskId, TaskStatus.RELEASED);
    await firstProviderRun.stop();

    expect(processedTaskIds).toEqual([firstTask.taskId]);

    const secondProviderRun = await startEventDrivenEchoProvider({
      config,
      blobStore,
      cursorDbPath,
      providerKeypair: provider.keypair,
      processedTaskIds,
    });

    const secondTask = await postTaskWithBlobStore({
      taskClient: consumerTaskClient,
      blobStore,
      input: 'Event driven task #2',
      keypair: consumer.keypair,
    });
    await waitForTaskStatus(consumerTaskClient, secondTask.taskId, TaskStatus.COMPLETED, EVENT_TIMEOUT + 15_000);
    await consumerTaskClient.releasePayment({ taskId: secondTask.taskId, keypair: consumer.keypair });
    const secondReleasedTask = await waitForTaskStatus(consumerTaskClient, secondTask.taskId, TaskStatus.RELEASED);
    await secondProviderRun.stop();

    expect(firstReleasedTask.resultBlobId).toBeTruthy();
    expect(processedTaskIds).toEqual([firstTask.taskId, secondTask.taskId]);
    expect(processedTaskIds.filter((taskId) => taskId === firstTask.taskId)).toHaveLength(1);
    expect(secondReleasedTask.resultBlobId).toBeTruthy();

    const resultData = await blobStore.fetch(secondReleasedTask.resultBlobId ?? '');
    expect(resultData).toBeTruthy();
    const result = JSON.parse(decoder.decode(resultData ?? new Uint8Array())) as Record<string, unknown>;
    expect(result.echo).toBe('Event driven task #2');
    expect(result.taskId).toBe(secondTask.taskId);
  }, 120_000);
});

function createNetworkConfig(): NetworkConfig {
  return {
    rpcUrl: network.rpcUrl,
    faucetUrl: network.faucetUrl,
    packageId: network.contractAddresses.packageId,
    registryId: network.contractAddresses.registryId,
  };
}

async function createArtifactDir(name: string): Promise<string> {
  const dir = join(artifactRoot, `${name}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createEchoCapability(amount = echoPriceMist) {
  return {
    name: 'echo',
    description: 'Echo service',
    version: '1.0.0',
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount,
      currency: 'MIST',
    },
  };
}

function createTestDid(name: string): string {
  return `did:mesh:${name}-${randomUUID()}`;
}

function buildEchoResult(taskId: string, capability: string, inputData: Uint8Array): Uint8Array {
  const result = {
    echo: decodeEchoInput(inputData),
    taskId,
    capability,
    timestamp: Date.now(),
    inputHash: createHash('sha256').update(inputData).digest('hex'),
  };

  return encoder.encode(JSON.stringify(result));
}

function decodeEchoInput(inputData: Uint8Array): string {
  try {
    return strictDecoder.decode(inputData);
  } catch {
    return Buffer.from(inputData).toString('hex');
  }
}

async function waitForTaskStatus(
  taskClient: TaskClient,
  taskId: string,
  status: TaskStatus,
  timeoutMs = EVENT_TIMEOUT,
) {
  return waitForCondition(async () => {
    const task = await taskClient.getTask(taskId);
    return task?.status === status ? task : undefined;
  }, timeoutMs, `Task ${taskId} never reached status ${TaskStatus[status]}`);
}

async function waitForCondition<T>(
  predicate: () => Promise<T | undefined>,
  timeoutMs: number,
  failureMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(pollIntervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${failureMessage}: ${lastError.message}`);
  }

  throw new Error(failureMessage);
}

async function startEventDrivenEchoProvider(params: {
  config: NetworkConfig;
  blobStore: FilesystemBlobStore;
  cursorDbPath: string;
  providerKeypair: Ed25519Keypair;
  processedTaskIds: string[];
}): Promise<EventDrivenProviderHandle> {
  const providerSui = new MeshSuiClient(params.config);
  const providerTaskClient = new TaskClient(providerSui, params.config);
  const cursorStore = new SqliteCursorStore(params.cursorDbPath);
  const eventType = `${params.config.packageId}::task::TaskPosted`;
  let lastProcessing = Promise.resolve();

  await seedCursorToLatestPostedTask(providerSui, eventType, cursorStore);

  const subscription = new EventSubscription({
    suiClient: providerSui,
    eventType,
    cursorStore,
    pollIntervalMs,
    onEvent: async (event) => {
      lastProcessing = handlePostedTaskEvent({
        event,
        config: params.config,
        blobStore: params.blobStore,
        providerTaskClient,
        providerKeypair: params.providerKeypair,
        processedTaskIds: params.processedTaskIds,
      });
      await lastProcessing;
    },
  });

  subscription.start();
  await delay(pollIntervalMs);

  return {
    async stop() {
      subscription.stop();
      await lastProcessing;
      await delay(pollIntervalMs);
      cursorStore.close();
    },
  };
}

async function seedCursorToLatestPostedTask(
  suiClient: MeshSuiClient,
  eventType: string,
  cursorStore: SqliteCursorStore,
): Promise<void> {
  const existingCursor = await cursorStore.getCursor(eventType);
  if (existingCursor) {
    return;
  }

  let cursor = null;
  let latestEvent: SuiEvent | undefined;

  do {
    const page = await suiClient.queryEvents(eventType, cursor, 100);
    if (page.events.length > 0) {
      latestEvent = page.events.at(-1);
    }

    cursor = page.nextCursor;
    if (!page.hasMore) {
      break;
    }
  } while (cursor);

  if (latestEvent) {
    await cursorStore.setCursor(eventType, latestEvent.id);
  }
}

async function handlePostedTaskEvent(params: {
  event: SuiEvent;
  config: NetworkConfig;
  blobStore: FilesystemBlobStore;
  providerTaskClient: TaskClient;
  providerKeypair: Ed25519Keypair;
  processedTaskIds: string[];
}): Promise<void> {
  const parsed = parseRawEvent(params.event, params.config.packageId);
  if (parsed?.type !== 'task.posted' || parsed.task.capability.toLowerCase() !== 'echo') {
    return;
  }

  const inputData = await params.blobStore.fetch(parsed.task.inputBlobId);
  if (!inputData) {
    throw new Error(`Missing input blob ${parsed.task.inputBlobId} for task ${parsed.task.id}`);
  }

  await params.providerTaskClient.acceptTask({
    taskId: parsed.task.id,
    keypair: params.providerKeypair,
  });

  const { blobId: resultBlobId } = await params.blobStore.store(
    buildEchoResult(parsed.task.id, parsed.task.capability, inputData),
  );

  await params.providerTaskClient.completeTask({
    taskId: parsed.task.id,
    resultBlobId,
    keypair: params.providerKeypair,
  });

  params.processedTaskIds.push(parsed.task.id);
}

async function postTaskWithBlobStore(params: {
  taskClient: TaskClient;
  blobStore: FilesystemBlobStore;
  input: string;
  keypair: Ed25519Keypair;
}): Promise<{ taskId: string; inputBlobId: string }> {
  const inputData = encoder.encode(params.input);
  const { blobId: inputBlobId } = await params.blobStore.store(inputData);
  const { taskId } = await params.taskClient.postTask({
    capability: 'echo',
    category: 'general',
    inputBlobId,
    priceMist: echoPriceMist,
    disputeWindowMs,
    expiryHours,
    keypair: params.keypair,
  });

  return { taskId, inputBlobId };
}

async function removeDirectoryWithRetries(path: string, attempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }

      await delay(attempt * 250);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
