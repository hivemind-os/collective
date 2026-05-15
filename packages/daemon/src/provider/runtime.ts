import { randomUUID } from 'node:crypto';

import pino from 'pino';

import {
  EventSubscription,
  SqliteCursorStore,
  UsageMeter,
  createMeteredResultEnvelope,
  parseEncryptedPayload,
  parseRawEvent,
  serializeMeteredResultEnvelope,
  splitIntoMeteringUnits,
} from '@agentic-mesh/core';
import { PaymentRail, PaymentScheme, type Capability, type RelayEndpoint, type Task, type TaskPostedEvent } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';

import type { DaemonFullConfig } from '../config.js';
import { RelayClient, type RelayClientConfig } from '../relay/relay-client.js';
import type { DaemonState } from '../state.js';
import { EchoAdapter } from './adapters/echo.js';
import type { ExecutionAdapter } from './adapters/interface.js';
import { LocalFunctionAdapter, type LocalFunction } from './adapters/local-fn.js';
import type { ProviderCapabilityConfig, ProviderConfig } from './capabilities.js';
import { TaskQueue } from './task-queue.js';

const logger = pino({ name: '@agentic-mesh/daemon:provider' });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ProviderRuntime {
  private subscription?: EventSubscription;
  private cursorStore?: SqliteCursorStore;
  private readonly taskQueue: TaskQueue;
  private readonly adapters = new Map<string, ExecutionAdapter>();
  private readonly capabilityConfigs = new Map<string, ProviderCapabilityConfig>();
  private readonly relayClients: RelayClient[] = [];
  private registeredCapabilities: string[] = [];
  private chainOperations: Promise<void> = Promise.resolve();
  private ownAgentCardId?: string;

  constructor(
    private readonly params: {
      state: DaemonState;
      providerConfig: ProviderConfig;
      cursorDbPath: string;
      relayConfig?: DaemonFullConfig['relay'];
      relayClientFactory?: (config: RelayClientConfig, identity: DaemonState['relayAuthProvider']) => RelayClient;
    },
  ) {
    this.taskQueue = new TaskQueue(params.providerConfig.maxConcurrency);
  }

  async start(): Promise<void> {
    if (this.subscription) {
      return;
    }

    this.initializeAdapters();
    await this.connectRelays();

    if (this.params.providerConfig.autoRegister) {
      await this.registerAgentCard();
    }

    await this.resolveOwnAgentCardId();

    const eventType = `${this.params.state.network.packageId}::task::TaskPosted`;
    this.cursorStore = new SqliteCursorStore(this.params.cursorDbPath);
    this.subscription = new EventSubscription({
      suiClient: this.params.state.suiClient,
      eventType,
      cursorStore: this.cursorStore,
      pollIntervalMs: 2_000,
      onEvent: async (event) => {
        await this.handleRawEvent(event);
      },
      onError: (error) => {
        logger.error({ err: error }, 'Provider subscription polling failed');
      },
    });
    this.subscription.start();
  }

  async stop(): Promise<void> {
    this.subscription?.stop();
    this.subscription = undefined;
    await Promise.all(this.relayClients.splice(0).map((client) => client.disconnect()));
    await this.taskQueue.drain();
    this.cursorStore?.close();
    this.cursorStore = undefined;
  }

  private async connectRelays(): Promise<void> {
    const relayConfig = this.params.relayConfig;
    if (!relayConfig?.enabled || !relayConfig.providerMode || !relayConfig.autoConnect) {
      return;
    }

    const factory = this.params.relayClientFactory ?? ((config, identity) => new RelayClient(config, identity));
    for (const endpoint of relayConfig.endpoints) {
      const client = factory(
        {
          relayUrl: endpoint.url,
          relayDid: endpoint.relayDid,
          reconnectIntervalMs: relayConfig.reconnectIntervalMs,
          heartbeatIntervalMs: relayConfig.heartbeatIntervalMs,
        },
        this.params.state.relayAuthProvider,
      );

      client.onTaskRequest(async (request) => {
        await client.sendProgress(request.taskId ?? 'relay-task', 0.1, 'Task accepted by provider runtime');
        const resultData = await this.executeLocalTask(
          request.taskId ?? randomUUID(),
          request.capability,
          encodeRelayInput(request.input),
        );
        await client.sendProgress(request.taskId ?? 'relay-task', 1, 'Task completed');

        return {
          taskId: request.taskId ?? randomUUID(),
          providerDid: this.params.state.did,
          sequence: 0,
          result: parseExecutionResult(resultData),
        };
      });

      await client.connect(this.registeredCapabilities);
      this.relayClients.push(client);
    }
  }

  private async handleRawEvent(event: SuiEvent): Promise<void> {
    const parsed = parseRawEvent(event, this.params.state.network.packageId);
    if (parsed?.type !== 'task.posted') {
      return;
    }

    await this.handleTaskPosted(parsed);
  }

  private async handleTaskPosted(event: TaskPostedEvent): Promise<void> {
    const capabilityKey = normalizeCapability(event.task.capability);
    if (!this.registeredCapabilities.some((registered) => normalizeCapability(registered) === capabilityKey)) {
      return;
    }

    if (this.taskQueue.isFull) {
      logger.warn({ taskId: event.task.id, capability: event.task.capability }, 'Provider queue is full');
      return;
    }

    const queued = await this.taskQueue.enqueue(event.task.id, async () => {
      try {
        await this.processTask(event.task);
      } catch (error) {
        logger.error({ err: error, taskId: event.task.id }, 'Task processing failed');
      }
    });

    if (!queued) {
      logger.warn({ taskId: event.task.id }, 'Task was not queued');
    }
  }

  private async processTask(task: Task): Promise<void> {
    const encryption = this.params.state.encryption ?? { enabled: false, requireEncryption: false };

    await this.runChainOperation(async () => {
      await this.params.state.taskClient.acceptTask({
        taskId: task.id,
        keypair: this.params.state.keypair,
      });
    });

    const rawInput = await this.params.state.blobStore.fetch(task.inputBlobId);
    if (!rawInput) {
      throw new Error(`Input blob ${task.inputBlobId} was not found.`);
    }

    const encryptedInput = parseEncryptedPayload(rawInput);
    if (encryption.requireEncryption && !encryptedInput) {
      throw new Error(`Task ${task.id} is missing an encrypted input payload.`);
    }

    const inputData = encryptedInput
      ? await fetchDecryptedPayload(this.params.state.blobStore, task.inputBlobId)
      : rawInput;
    const result = await this.executeLocalTask(task.id, task.capability, inputData);

    const requesterCard = await this.params.state.registryClient.getAgentCardByOwner(task.requester);
    const requesterEncryptionKey = decodeHexKey(requesterCard?.encryptionPublicKey);
    if (encryption.requireEncryption && !requesterEncryptionKey) {
      throw new Error(`Task ${task.id} requester does not publish an encryption key.`);
    }

    const completionPayload = prepareCompletionPayload(task, result);
    const storedResult = encryption.enabled && requesterEncryptionKey
      ? await storeEncryptedPayload(this.params.state.blobStore, completionPayload.resultData, requesterEncryptionKey)
      : await this.params.state.blobStore.store(completionPayload.resultData);

    await this.runChainOperation(async () => {
      if (completionPayload.metered) {
        await this.params.state.taskClient.completeMeteredTask({
          taskId: task.id,
          resultBlobId: storedResult.blobId,
          meteredUnits: completionPayload.metered.actualUnits,
          verificationHash: completionPayload.metered.verificationHash,
          keypair: this.params.state.keypair,
          providerCardId: this.ownAgentCardId,
        });
        return;
      }

      await this.params.state.taskClient.completeTask({
        taskId: task.id,
        resultBlobId: storedResult.blobId,
        keypair: this.params.state.keypair,
        providerCardId: this.ownAgentCardId,
      });
    });
  }

  private async executeLocalTask(taskId: string, capability: string, inputData: Uint8Array): Promise<Uint8Array> {
    const adapter = this.adapters.get(normalizeCapability(capability));
    if (!adapter) {
      throw new Error(`No adapter configured for capability ${capability}.`);
    }

    const result = await adapter.execute({
      taskId,
      capability,
      inputData,
    });

    return result.resultData;
  }

  private async runChainOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.chainOperations.then(operation, operation);
    this.chainOperations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private initializeAdapters(): void {
    this.adapters.clear();
    this.capabilityConfigs.clear();
    this.registeredCapabilities = [];

    for (const capability of this.params.providerConfig.capabilities) {
      try {
        const key = normalizeCapability(capability.name);
        const adapter = createAdapter(capability);
        this.adapters.set(key, adapter);
        this.capabilityConfigs.set(key, capability);
        this.registeredCapabilities.push(capability.name);
      } catch (error) {
        logger.warn({ err: error, capability: capability.name }, 'Skipping invalid provider capability');
      }
    }
  }

  private async registerAgentCard(): Promise<void> {
    const encryption = this.params.state.encryption ?? { enabled: false, requireEncryption: false };
    const capabilities = this.params.providerConfig.capabilities
      .filter((capability) => this.capabilityConfigs.has(normalizeCapability(capability.name)))
      .map((capability) => toCapability(capability, this.hasRelaySupport));

    if (capabilities.length === 0) {
      logger.warn('Skipping auto-registration because no provider capabilities are available');
      return;
    }

    try {
      const registration = await this.params.state.registryClient.registerAgent({
        name: 'Agentic Mesh Provider',
        description: `Auto-registered provider for ${this.params.state.did}`,
        did: this.params.state.did,
        capabilities,
        endpoint: this.registrationEndpoint,
        encryptionPublicKey: encryption.enabled
          ? this.params.state.encryptionKeyPair?.publicKey
          : undefined,
        keypair: this.params.state.keypair,
      });
      this.ownAgentCardId = registration.agentCardId;
      const card = await this.params.state.registryClient.getAgentCard(registration.agentCardId);
      if (card) {
        this.params.state.agentCache.upsertAgent({
          ...card,
          endpoint: this.registrationEndpoint,
          relayEndpoints: this.relayMetadata,
          capabilities,
        });
      }
      logger.info({ agentCardId: registration.agentCardId }, 'Provider agent card registered');
    } catch (error) {
      logger.error({ err: error }, 'Provider auto-registration failed');
    }
  }

  private async resolveOwnAgentCardId(): Promise<void> {
    const cached = this.params.state.agentCache.getAgentByDID?.(this.params.state.did);
    if (cached?.id) {
      this.ownAgentCardId = cached.id;
      return;
    }

    const discovered = await this.params.state.registryClient.findAgentByDid?.(this.params.state.did);
    if (discovered?.id) {
      this.ownAgentCardId = discovered.id;
      this.params.state.agentCache.upsertAgent(discovered);
    }
  }

  private get hasRelaySupport(): boolean {
    return this.relayClients.length > 0 && this.relayMetadata.length > 0;
  }

  private get relayMetadata(): RelayEndpoint[] {
    const relayConfig = this.params.relayConfig;
    if (!relayConfig?.enabled || !relayConfig.providerMode) {
      return [];
    }

    return relayConfig.endpoints.map(
      (endpoint): RelayEndpoint => ({
        relayDid: endpoint.relayDid as DaemonState['did'] | undefined,
        endpoint: endpoint.url,
        modes: ['sync', 'streaming', 'fallback'],
      }),
    );
  }

  private get registrationEndpoint(): string {
    const relay = this.relayMetadata[0];
    if (!relay) {
      return `mesh://agent/${this.params.state.did}`;
    }

    return relay.endpoint.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/v1\/ws$/i, '');
  }
}

function createAdapter(capability: ProviderCapabilityConfig): ExecutionAdapter {
  switch (capability.adapter) {
    case 'echo':
      return new EchoAdapter();
    case 'local-function': {
      const fnCandidate = capability.adapterConfig?.fn ?? capability.adapterConfig?.function;
      if (typeof fnCandidate !== 'function') {
        throw new Error(`Capability ${capability.name} is missing a local function adapter.`);
      }
      return new LocalFunctionAdapter(fnCandidate as LocalFunction);
    }
    default:
      throw new Error(`Unsupported execution adapter: ${capability.adapter}`);
  }
}

function toCapability(capability: ProviderCapabilityConfig, hasRelaySupport: boolean): Capability {
  return {
    name: capability.name,
    description: capability.description,
    version: capability.version,
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: BigInt(capability.priceMist),
      currency: capability.currency ?? 'MIST',
    },
    executionMode: hasRelaySupport ? 'sync' : 'async',
    paymentRails: hasRelaySupport
      ? [PaymentRail.SUI_TRANSFER, PaymentRail.X402_BASE, PaymentRail.SUI_ESCROW]
      : [PaymentRail.SUI_ESCROW],
  };
}

function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase();
}

function prepareCompletionPayload(task: Task, resultData: Uint8Array): {
  resultData: Uint8Array;
  metered?: {
    actualUnits: number;
    verificationHash: string;
  };
} {
  if (task.paymentScheme !== PaymentScheme.UPTO && task.paymentScheme !== PaymentScheme.STREAM) {
    return { resultData };
  }

  const meter = new UsageMeter({
    taskId: task.id,
    maxPrice: task.maxPrice ?? task.price,
    unitPrice: task.unitPrice ?? 0n,
  });
  for (const unit of splitIntoMeteringUnits(resultData)) {
    meter.recordUnit(unit);
  }

  const envelope = createMeteredResultEnvelope(resultData, meter.getProof());
  return {
    resultData: serializeMeteredResultEnvelope(envelope),
    metered: {
      actualUnits: meter.getActualUnits(),
      verificationHash: meter.getVerificationHash(),
    },
  };
}

function encodeRelayInput(input: unknown): Uint8Array {
  return encoder.encode(typeof input === 'string' ? input : JSON.stringify(input));
}

interface EncryptedBlobStoreLike {
  storeEncrypted(data: Uint8Array, recipientPublicKey: Uint8Array): Promise<{ blobId: string; hash: string }>;
  fetchDecrypted(blobId: string): Promise<Uint8Array | null>;
}

function isEncryptedBlobStore(blobStore: DaemonState['blobStore']): blobStore is DaemonState['blobStore'] & EncryptedBlobStoreLike {
  return typeof (blobStore as Partial<EncryptedBlobStoreLike>).storeEncrypted === 'function'
    && typeof (blobStore as Partial<EncryptedBlobStoreLike>).fetchDecrypted === 'function';
}

async function fetchDecryptedPayload(blobStore: DaemonState['blobStore'], blobId: string): Promise<Uint8Array> {
  if (!isEncryptedBlobStore(blobStore)) {
    throw new Error('Encrypted payloads require an encrypted blobstore.');
  }

  const data = await blobStore.fetchDecrypted(blobId);
  if (!data) {
    throw new Error(`Input blob ${blobId} was not found.`);
  }

  return data;
}

async function storeEncryptedPayload(
  blobStore: DaemonState['blobStore'],
  data: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<{ blobId: string; hash: string }> {
  if (!isEncryptedBlobStore(blobStore)) {
    throw new Error('Encrypted payloads require an encrypted blobstore.');
  }

  return await blobStore.storeEncrypted(data, recipientPublicKey);
}

function decodeHexKey(value?: string): Uint8Array | null {
  if (!value || value.length !== 64 || !/^[a-f0-9]+$/i.test(value)) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, 'hex'));
}

function parseExecutionResult(resultData: Uint8Array): unknown {
  const text = decoder.decode(resultData);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
