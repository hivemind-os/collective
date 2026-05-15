import { createHash } from 'node:crypto';

import { FilesystemBlobStore, MeshSuiClient, RegistryClient, TaskClient } from '@agentic-mesh/core';
import { ProviderRuntime, type ProviderConfig } from '@agentic-mesh/daemon/provider';
import type { DaemonState } from '@agentic-mesh/daemon/state';
import { TaskStatus } from '@agentic-mesh/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  createArtifactDir,
  createArtifactRoot,
  createNetworkConfig,
  createTestDid,
  decoder,
  parseJson,
  postTaskWithBlobStore,
  removeDirectoryWithRetries,
  waitForCondition,
  waitForTaskStatus,
} from './test-helpers.js';

const testTimeoutMs = 60_000;

let artifactRoot: string;
let network: SuiTestNetwork;
const activeRuntimes: ProviderRuntime[] = [];

describe('Phase 1 E2E: Provider runtime', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('provider-runtime');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterEach(async () => {
    while (activeRuntimes.length > 0) {
      await activeRuntimes.pop()?.stop().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'starts, auto-registers its capability, and auto-accepts matching tasks',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const capabilityName = `provider-auto-${Date.now()}`;
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'provider-auto'));
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const consumerRegistryClient = new RegistryClient(new MeshSuiClient(config), config);
      const runtime = new ProviderRuntime({
        state: createProviderState({ config, provider, blobStore, did: createTestDid('runtime-auto') }),
        providerConfig: {
          enabled: true,
          autoRegister: true,
          maxConcurrency: 1,
          capabilities: [
            {
              name: capabilityName,
              description: 'Provider runtime auto-registration capability',
              version: '1.0.0',
              priceMist: 100_000_000,
              adapter: 'echo',
            },
          ],
        },
        cursorDbPath: await createCursorDbPath('provider-auto-cursor'),
      });
      activeRuntimes.push(runtime);

      await runtime.start();

      const discovered = await waitForCondition(
        async () => {
          const agents = await consumerRegistryClient.discoverByCapability(capabilityName, 20);
          return agents.find((agent) => agent.owner === provider.address);
        },
        20_000,
        'Auto-registered provider was not discoverable',
      );

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'provider runtime auto-accept',
        capability: capabilityName,
        keypair: consumer.keypair,
      });
      const completedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.COMPLETED, 20_000);

      expect(discovered.did).toMatch(/^did:mesh:/);
      expect(completedTask.provider).toBe(provider.address);
      await runtime.stop();
    },
    testTimeoutMs,
  );

  it(
    'processes matching tasks end-to-end with the echo adapter',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const capabilityName = `provider-echo-${Date.now()}`;
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'provider-echo'));
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const runtime = new ProviderRuntime({
        state: createProviderState({ config, provider, blobStore, did: createTestDid('runtime-echo') }),
        providerConfig: {
          enabled: true,
          autoRegister: false,
          maxConcurrency: 1,
          capabilities: [
            {
              name: capabilityName,
              description: 'Echo capability for runtime e2e',
              version: '1.0.0',
              priceMist: 100_000_000,
              adapter: 'echo',
            },
          ],
        },
        cursorDbPath: await createCursorDbPath('provider-echo-cursor'),
      });
      activeRuntimes.push(runtime);

      await runtime.start();
      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'echo via provider runtime',
        capability: capabilityName,
        keypair: consumer.keypair,
      });
      const completedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.COMPLETED, 20_000);

      await consumerTaskClient.releasePayment({ taskId: posted.taskId, keypair: consumer.keypair });
      const releasedTask = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.RELEASED, 20_000);
      const resultData = await blobStore.fetch(releasedTask.resultBlobId ?? '');
      const result = parseJson<{ echo: string; taskId: string; capability: string; inputHash: string }>(
        resultData ?? new Uint8Array(),
      );

      expect(completedTask.provider).toBe(provider.address);
      expect(result.echo).toBe('echo via provider runtime');
      expect(result.taskId).toBe(posted.taskId);
      expect(result.capability).toBe(capabilityName);
      expect(result.inputHash).toBe(createHash('sha256').update(Buffer.from('echo via provider runtime')).digest('hex'));

      await runtime.stop();
    },
    testTimeoutMs,
  );

  it(
    "ignores tasks for capabilities it doesn't support",
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'provider-ignore'));
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const runtime = new ProviderRuntime({
        state: createProviderState({ config, provider, blobStore, did: createTestDid('runtime-ignore') }),
        providerConfig: {
          enabled: true,
          autoRegister: false,
          maxConcurrency: 1,
          capabilities: [
            {
              name: `supported-${Date.now()}`,
              description: 'Only this capability is supported',
              version: '1.0.0',
              priceMist: 100_000_000,
              adapter: 'echo',
            },
          ],
        },
        cursorDbPath: await createCursorDbPath('provider-ignore-cursor'),
      });
      activeRuntimes.push(runtime);

      await runtime.start();
      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'unsupported capability payload',
        capability: `unsupported-${Date.now()}`,
        keypair: consumer.keypair,
      });

      await waitForCondition(async () => {
        const task = await consumerTaskClient.getTask(posted.taskId);
        return task?.status === TaskStatus.OPEN ? task : undefined;
      }, 5_000, 'Unsupported task did not remain open');

      const task = await consumerTaskClient.getTask(posted.taskId);
      expect(task?.provider).toBeUndefined();
      expect(task?.status).toBe(TaskStatus.OPEN);
      await runtime.stop();
    },
    testTimeoutMs,
  );

  it(
    'handles multiple concurrent matching tasks',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const capabilityName = `provider-concurrency-${Date.now()}`;
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'provider-concurrency'));
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      let activeExecutions = 0;
      let maxConcurrentExecutions = 0;
      let releaseWork!: () => void;
      const allowCompletion = new Promise<void>((resolvePromise) => {
        releaseWork = resolvePromise;
      });
      const startedTaskIds: string[] = [];
      const runtime = new ProviderRuntime({
        state: createProviderState({ config, provider, blobStore, did: createTestDid('runtime-concurrency') }),
        providerConfig: {
          enabled: true,
          autoRegister: false,
          maxConcurrency: 2,
          capabilities: [
            {
              name: capabilityName,
              description: 'Concurrent local-function capability',
              version: '1.0.0',
              priceMist: 100_000_000,
              adapter: 'local-function',
              adapterConfig: {
                fn: async (inputData: Uint8Array) => {
                  startedTaskIds.push(decoder.decode(inputData));
                  activeExecutions += 1;
                  maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
                  await allowCompletion;
                  activeExecutions -= 1;
                  return Buffer.from(
                    JSON.stringify({
                      echo: decoder.decode(inputData),
                    }),
                  );
                },
              },
            },
          ],
        } as ProviderConfig,
        cursorDbPath: await createCursorDbPath('provider-concurrency-cursor'),
      });
      activeRuntimes.push(runtime);

      await runtime.start();
      const first = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'concurrent-one',
        capability: capabilityName,
        keypair: consumer.keypair,
      });
      const second = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'concurrent-two',
        capability: capabilityName,
        keypair: consumer.keypair,
      });

      await waitForCondition(
        async () =>
          startedTaskIds.includes('concurrent-one') && startedTaskIds.includes('concurrent-two')
            ? startedTaskIds.slice()
            : undefined,
        20_000,
        'Provider did not begin both tasks concurrently',
      );
      releaseWork();

      const [firstCompleted, secondCompleted] = await Promise.all([
        waitForTaskStatus(consumerTaskClient, first.taskId, TaskStatus.COMPLETED, 20_000),
        waitForTaskStatus(consumerTaskClient, second.taskId, TaskStatus.COMPLETED, 20_000),
      ]);

      expect(maxConcurrentExecutions).toBe(2);
      expect(firstCompleted.provider).toBe(provider.address);
      expect(secondCompleted.provider).toBe(provider.address);
      await runtime.stop();
    },
    testTimeoutMs,
  );

  it(
    'shuts down gracefully by finishing in-progress work and skipping newly posted tasks',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const capabilityName = `provider-shutdown-${Date.now()}`;
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'provider-shutdown'));
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      let releaseWork!: () => void;
      const allowCompletion = new Promise<void>((resolvePromise) => {
        releaseWork = resolvePromise;
      });
      const startedTaskIds: string[] = [];
      const runtime = new ProviderRuntime({
        state: createProviderState({ config, provider, blobStore, did: createTestDid('runtime-shutdown') }),
        providerConfig: {
          enabled: true,
          autoRegister: false,
          maxConcurrency: 1,
          capabilities: [
            {
              name: capabilityName,
              description: 'Graceful shutdown capability',
              version: '1.0.0',
              priceMist: 100_000_000,
              adapter: 'local-function',
              adapterConfig: {
                fn: async (inputData: Uint8Array) => {
                  startedTaskIds.push(decoder.decode(inputData));
                  await allowCompletion;
                  return Buffer.from(
                    JSON.stringify({
                      echo: decoder.decode(inputData),
                    }),
                  );
                },
              },
            },
          ],
        } as ProviderConfig,
        cursorDbPath: await createCursorDbPath('provider-shutdown-cursor'),
      });
      activeRuntimes.push(runtime);

      await runtime.start();
      const firstTask = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'finish me before shutdown',
        capability: capabilityName,
        keypair: consumer.keypair,
      });
      await waitForCondition(
        async () =>
          startedTaskIds.includes('finish me before shutdown') ? 'finish me before shutdown' : undefined,
        20_000,
        'Provider did not start the in-progress task',
      );

      const stopPromise = runtime.stop();
      const secondTask = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'do not accept me after shutdown',
        capability: capabilityName,
        keypair: consumer.keypair,
      });
      releaseWork();
      await stopPromise;

      const completedFirstTask = await waitForTaskStatus(consumerTaskClient, firstTask.taskId, TaskStatus.COMPLETED, 20_000);
      await waitForCondition(async () => {
        const task = await consumerTaskClient.getTask(secondTask.taskId);
        return task?.status === TaskStatus.OPEN ? task : undefined;
      }, 5_000, 'Task posted during shutdown should have remained open');

      const remainingOpenTask = await consumerTaskClient.getTask(secondTask.taskId);
      expect(completedFirstTask.provider).toBe(provider.address);
      expect(remainingOpenTask?.provider).toBeUndefined();
      expect(remainingOpenTask?.status).toBe(TaskStatus.OPEN);
    },
    testTimeoutMs,
  );
});

function createProviderState(params: {
  config: ReturnType<typeof createNetworkConfig>;
  provider: Awaited<ReturnType<SuiTestNetwork['createFundedWallet']>>;
  blobStore: FilesystemBlobStore;
  did: `did:mesh:${string}`;
}): DaemonState {
  const suiClient = new MeshSuiClient(params.config);
  return {
    did: params.did,
    keypair: params.provider.keypair,
    address: params.provider.address,
    network: params.config,
    suiClient,
    registryClient: new RegistryClient(suiClient, params.config),
    taskClient: new TaskClient(suiClient, params.config),
    blobStore: params.blobStore,
    agentCache: {
      upsertAgent: () => undefined,
    },
  } as unknown as DaemonState;
}

async function createCursorDbPath(name: string): Promise<string> {
  return `${await createArtifactDir(artifactRoot, name)}\\provider-cursor.sqlite`;
}
