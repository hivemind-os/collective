import { join } from 'node:path';

import {
  EventSubscription,
  FilesystemBlobStore,
  MeshSuiClient,
  parseRawEvent,
  SqliteCursorStore,
  TaskClient,
} from '@hivemind-os/collective-core';
import type { MeshEvent } from '@hivemind-os/collective-types';
import { TaskStatus } from '@hivemind-os/collective-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  createArtifactDir,
  createArtifactRoot,
  createNetworkConfig,
  defaultPriceMist,
  postTaskWithBlobStore,
  removeDirectoryWithRetries,
  seedCursorToLatestEvent,
  waitForCondition,
  waitForTaskStatus,
} from './test-helpers.js';

const testTimeoutMs = 60_000;
const subscriptionPollMs = 200;

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 1 E2E: Event subscriptions', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('event-subscription');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'receives TaskPosted events when tasks are posted',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const suiClient = new MeshSuiClient(config);
      const taskClient = new TaskClient(suiClient, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'task-posted'));
      const eventType = `${config.packageId}::task::TaskPosted`;
      const cursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-task-posted'), 'cursor.sqlite'));
      const received: MeshEvent[] = [];

      await seedCursorToLatestEvent(suiClient, eventType, cursorStore);
      const subscription = new EventSubscription({
        suiClient,
        eventType,
        cursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed) {
            received.push(parsed);
          }
        },
      });
      subscription.start();

      const posted = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:task-posted',
        capability: 'events-posted',
        priceMist: defaultPriceMist,
        keypair: consumer.keypair,
      });

      const event = await waitForCondition(
        async () => received.find((entry) => entry.type === 'task.posted' && entry.task.id === posted.taskId),
        15_000,
        'TaskPosted event was not received',
      );

      expect(event.type).toBe('task.posted');
      if (event.type !== 'task.posted') {
        throw new Error('Unexpected event type');
      }
      expect(event.task.inputBlobId).toBe(posted.inputBlobId);
      subscription.stop();
      cursorStore.close();
    },
    testTimeoutMs,
  );

  it(
    'receives TaskAccepted events when a provider accepts a task',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const providerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'task-accepted'));
      const eventType = `${config.packageId}::task::TaskAccepted`;
      const cursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-task-accepted'), 'cursor.sqlite'));
      const received: MeshEvent[] = [];

      await seedCursorToLatestEvent(new MeshSuiClient(config), eventType, cursorStore);
      const subscription = new EventSubscription({
        suiClient: new MeshSuiClient(config),
        eventType,
        cursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed) {
            received.push(parsed);
          }
        },
      });
      subscription.start();

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'event:task-accepted',
        capability: 'events-accepted',
        keypair: consumer.keypair,
      });
      await providerTaskClient.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });

      const event = await waitForCondition(
        async () => received.find((entry) => entry.type === 'task.accepted' && entry.taskId === posted.taskId),
        15_000,
        'TaskAccepted event was not received',
      );

      expect(event.type).toBe('task.accepted');
      if (event.type !== 'task.accepted') {
        throw new Error('Unexpected event type');
      }
      expect(event.provider).toBe(provider.address);
      subscription.stop();
      cursorStore.close();
    },
    testTimeoutMs,
  );

  it(
    'persists cursors and resumes from the last processed event after restart',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const suiClient = new MeshSuiClient(config);
      const taskClient = new TaskClient(suiClient, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'cursor-persistence'));
      const eventType = `${config.packageId}::task::TaskPosted`;
      const cursorDbPath = join(await createArtifactDir(artifactRoot, 'cursor-persistence-db'), 'cursor.sqlite');
      const firstCursorStore = new SqliteCursorStore(cursorDbPath);
      const firstRunEvents: string[] = [];

      await seedCursorToLatestEvent(suiClient, eventType, firstCursorStore);
      const firstSubscription = new EventSubscription({
        suiClient,
        eventType,
        cursorStore: firstCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            firstRunEvents.push(parsed.task.id);
          }
        },
      });
      firstSubscription.start();

      const firstTask = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:first-run',
        capability: 'events-cursor',
        keypair: consumer.keypair,
      });
      await waitForCondition(
        async () => (firstRunEvents.includes(firstTask.taskId) ? firstTask.taskId : undefined),
        15_000,
        'First subscription never received its task',
      );
      firstSubscription.stop();
      firstCursorStore.close();

      const secondTask = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:second-run',
        capability: 'events-cursor',
        keypair: consumer.keypair,
      });

      const secondRunEvents: string[] = [];
      const secondCursorStore = new SqliteCursorStore(cursorDbPath);
      const secondSubscription = new EventSubscription({
        suiClient,
        eventType,
        cursorStore: secondCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            secondRunEvents.push(parsed.task.id);
          }
        },
      });
      secondSubscription.start();

      await waitForCondition(
        async () => (secondRunEvents.includes(secondTask.taskId) ? secondTask.taskId : undefined),
        15_000,
        'Restarted subscription did not resume from stored cursor',
      );

      expect(secondRunEvents).toContain(secondTask.taskId);
      expect(secondRunEvents).not.toContain(firstTask.taskId);
      secondSubscription.stop();
      secondCursorStore.close();
    },
    testTimeoutMs,
  );

  it(
    'delivers the same events to multiple subscribers',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const taskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'multiple-subscribers'));
      const eventType = `${config.packageId}::task::TaskPosted`;
      const firstCursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-multi-1'), 'cursor.sqlite'));
      const secondCursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-multi-2'), 'cursor.sqlite'));
      const firstReceived: string[] = [];
      const secondReceived: string[] = [];

      await Promise.all([
        seedCursorToLatestEvent(new MeshSuiClient(config), eventType, firstCursorStore),
        seedCursorToLatestEvent(new MeshSuiClient(config), eventType, secondCursorStore),
      ]);

      const firstSubscription = new EventSubscription({
        suiClient: new MeshSuiClient(config),
        eventType,
        cursorStore: firstCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            firstReceived.push(parsed.task.id);
          }
        },
      });
      const secondSubscription = new EventSubscription({
        suiClient: new MeshSuiClient(config),
        eventType,
        cursorStore: secondCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            secondReceived.push(parsed.task.id);
          }
        },
      });
      firstSubscription.start();
      secondSubscription.start();

      const posted = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:multiple-subscribers',
        capability: 'events-multi',
        keypair: consumer.keypair,
      });

      await Promise.all([
        waitForCondition(
          async () => (firstReceived.includes(posted.taskId) ? posted.taskId : undefined),
          15_000,
          'First subscriber missed the task event',
        ),
        waitForCondition(
          async () => (secondReceived.includes(posted.taskId) ? posted.taskId : undefined),
          15_000,
          'Second subscriber missed the task event',
        ),
      ]);

      firstSubscription.stop();
      secondSubscription.stop();
      firstCursorStore.close();
      secondCursorStore.close();
    },
    testTimeoutMs,
  );

  it(
    'filters events by subscribing to specific event types',
    async () => {
      const consumer = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const providerTaskClient = new TaskClient(new MeshSuiClient(config), config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'event-filtering'));
      const postedEventType = `${config.packageId}::task::TaskPosted`;
      const acceptedEventType = `${config.packageId}::task::TaskAccepted`;
      const postedCursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-filter-posted'), 'cursor.sqlite'));
      const acceptedCursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-filter-accepted'), 'cursor.sqlite'));
      const postedEvents: string[] = [];
      const acceptedEvents: string[] = [];

      await Promise.all([
        seedCursorToLatestEvent(new MeshSuiClient(config), postedEventType, postedCursorStore),
        seedCursorToLatestEvent(new MeshSuiClient(config), acceptedEventType, acceptedCursorStore),
      ]);

      const postedSubscription = new EventSubscription({
        suiClient: new MeshSuiClient(config),
        eventType: postedEventType,
        cursorStore: postedCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            postedEvents.push(parsed.task.id);
          }
        },
      });
      const acceptedSubscription = new EventSubscription({
        suiClient: new MeshSuiClient(config),
        eventType: acceptedEventType,
        cursorStore: acceptedCursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.accepted') {
            acceptedEvents.push(parsed.taskId);
          }
        },
      });
      postedSubscription.start();
      acceptedSubscription.start();

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore,
        input: 'event:filtered',
        capability: 'events-filter',
        keypair: consumer.keypair,
      });
      await providerTaskClient.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);

      await Promise.all([
        waitForCondition(
          async () => (postedEvents.includes(posted.taskId) ? posted.taskId : undefined),
          15_000,
          'Posted-event subscription missed the task',
        ),
        waitForCondition(
          async () => (acceptedEvents.includes(posted.taskId) ? posted.taskId : undefined),
          15_000,
          'Accepted-event subscription missed the task',
        ),
      ]);

      expect(postedEvents).toContain(posted.taskId);
      expect(acceptedEvents).toContain(posted.taskId);
      postedSubscription.stop();
      acceptedSubscription.stop();
      postedCursorStore.close();
      acceptedCursorStore.close();
    },
    testTimeoutMs,
  );

  it(
    'replays historical events from the beginning when no cursor is stored',
    async () => {
      const consumer = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const suiClient = new MeshSuiClient(config);
      const taskClient = new TaskClient(suiClient, config);
      const blobStore = new FilesystemBlobStore(await createArtifactDir(artifactRoot, 'historical-replay'));
      const eventType = `${config.packageId}::task::TaskPosted`;
      const cursorStore = new SqliteCursorStore(join(await createArtifactDir(artifactRoot, 'cursor-historical'), 'cursor.sqlite'));
      const replayedTaskIds: string[] = [];

      const first = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:historical-1',
        capability: 'events-historical',
        keypair: consumer.keypair,
      });
      const second = await postTaskWithBlobStore({
        taskClient,
        blobStore,
        input: 'event:historical-2',
        capability: 'events-historical',
        keypair: consumer.keypair,
      });

      const subscription = new EventSubscription({
        suiClient,
        eventType,
        cursorStore,
        pollIntervalMs: subscriptionPollMs,
        onEvent: async (event) => {
          const parsed = parseRawEvent(event, config.packageId);
          if (parsed?.type === 'task.posted') {
            replayedTaskIds.push(parsed.task.id);
          }
        },
      });
      subscription.start();

      await waitForCondition(
        async () =>
          replayedTaskIds.includes(first.taskId) && replayedTaskIds.includes(second.taskId)
            ? replayedTaskIds.slice()
            : undefined,
        15_000,
        'Historical replay did not include both posted tasks',
      );

      expect(replayedTaskIds).toEqual(expect.arrayContaining([first.taskId, second.taskId]));
      subscription.stop();
      cursorStore.close();
    },
    testTimeoutMs,
  );
});
