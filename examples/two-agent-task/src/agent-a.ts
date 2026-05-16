import { randomUUID } from 'node:crypto';

import {
  EventSubscription,
  FilesystemBlobStore,
  MeshSuiClient,
  parseRawEvent,
  RegistryClient,
  SqliteCursorStore,
  TaskClient,
} from '@agentic-mesh/core';
import { PaymentRail, type Capability, type NetworkConfig } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { delay } from './setup.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const POLL_INTERVAL_MS = 500;

export const ECHO_CAPABILITY_NAME = 'echo';
export const ECHO_PRICE_MIST = 100_000_000n;

export interface ProviderRegistration {
  agentCardId: string;
  did: string;
  capability: Capability;
}

export interface ProviderListenerHandle {
  processedTaskIds: string[];
  stop(): Promise<void>;
}

interface ProviderAgentOptions {
  networkConfig: NetworkConfig;
  keypair: Ed25519Keypair;
  blobStore: FilesystemBlobStore;
  cursorDbPath: string;
  log?: (message: string) => void;
}

export async function registerProvider(params: ProviderAgentOptions): Promise<ProviderRegistration> {
  const suiClient = new MeshSuiClient(params.networkConfig);
  const registryClient = new RegistryClient(suiClient, params.networkConfig);
  const did = `did:mesh:agent-a-${randomUUID()}`;
  const capability = createEchoCapability();

  const { agentCardId } = await registryClient.registerAgent({
    name: 'Agent A',
    did,
    description: 'Provider agent that accepts echo tasks and returns the same payload.',
    capabilities: [capability],
    endpoint: 'mesh://two-agent-demo/agent-a',
    keypair: params.keypair,
  });

  params.log?.(`🪪 Registered Agent A with card ${agentCardId}.`);
  return { agentCardId, did, capability };
}

export async function startListening(params: ProviderAgentOptions): Promise<ProviderListenerHandle> {
  const providerSui = new MeshSuiClient(params.networkConfig);
  const providerTaskClient = new TaskClient(providerSui, params.networkConfig);
  const cursorStore = new SqliteCursorStore(params.cursorDbPath);
  const eventType = `${params.networkConfig.packageId}::task::TaskPosted`;
  const processedTaskIds: string[] = [];
  let lastProcessing = Promise.resolve();

  await seedCursorToLatestEvent(providerSui, eventType, cursorStore);

  const subscription = new EventSubscription({
    suiClient: providerSui,
    eventType,
    cursorStore,
    pollIntervalMs: POLL_INTERVAL_MS,
    onEvent: async (event) => {
      lastProcessing = handlePostedTaskEvent({
        event,
        networkConfig: params.networkConfig,
        blobStore: params.blobStore,
        providerTaskClient,
        providerKeypair: params.keypair,
        processedTaskIds,
        log: params.log,
      });
      await lastProcessing;
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      params.log?.(`⚠️ Agent A listener error: ${message}`);
    },
  });

  subscription.start();
  await delay(POLL_INTERVAL_MS);
  params.log?.('👂 Agent A is polling for posted echo tasks.');

  return {
    processedTaskIds,
    async stop() {
      subscription.stop();
      await lastProcessing.catch(() => undefined);
      await delay(POLL_INTERVAL_MS);
      cursorStore.close();
    },
  };
}

function createEchoCapability(): Capability {
  return {
    name: ECHO_CAPABILITY_NAME,
    description: 'Returns the task input unchanged.',
    version: '1.0.0',
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: ECHO_PRICE_MIST,
      currency: 'MIST',
    },
  };
}

async function seedCursorToLatestEvent(
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
  networkConfig: NetworkConfig;
  blobStore: FilesystemBlobStore;
  providerTaskClient: TaskClient;
  providerKeypair: Ed25519Keypair;
  processedTaskIds: string[];
  log?: (message: string) => void;
}): Promise<void> {
  const parsed = parseRawEvent(params.event, params.networkConfig.packageId);
  if (parsed?.type !== 'task.posted' || parsed.task.capability.toLowerCase() !== ECHO_CAPABILITY_NAME) {
    return;
  }

  if (params.processedTaskIds.includes(parsed.task.id)) {
    return;
  }

  params.log?.(`📥 Agent A detected task ${parsed.task.id}.`);
  const inputData = await params.blobStore.fetch(parsed.task.inputBlobId);
  if (!inputData) {
    throw new Error(`Missing input blob ${parsed.task.inputBlobId} for task ${parsed.task.id}.`);
  }

  await params.providerTaskClient.acceptTask({
    taskId: parsed.task.id,
    keypair: params.providerKeypair,
  });
  params.log?.(`🤝 Agent A accepted task ${parsed.task.id}.`);

  const { blobId: resultBlobId } = await params.blobStore.store(
    encoder.encode(
      JSON.stringify({
        echo: decodeInput(inputData),
        taskId: parsed.task.id,
        capability: parsed.task.capability,
        completedBy: 'Agent A',
        timestamp: Date.now(),
      }),
    ),
  );

  await params.providerTaskClient.completeTask({
    taskId: parsed.task.id,
    resultBlobId,
    keypair: params.providerKeypair,
  });

  params.processedTaskIds.push(parsed.task.id);
  params.log?.(`✅ Agent A completed task ${parsed.task.id} with blob ${resultBlobId}.`);
}

function decodeInput(inputData: Uint8Array): string {
  try {
    return decoder.decode(inputData);
  } catch {
    return Buffer.from(inputData).toString('hex');
  }
}
