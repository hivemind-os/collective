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
} from '@hivemind-os/collective-core';
import { PaymentRail, PaymentScheme, type Capability, type RelayEndpoint, type Task, type TaskPostedEvent } from '@hivemind-os/collective-types';
import type { SuiEvent } from '@mysten/sui/client';

import type { DaemonFullConfig } from '../config.js';
import { RelayClient, type RelayClientConfig } from '../relay/relay-client.js';
import type { DaemonState } from '../state.js';
import { EchoAdapter } from './adapters/echo.js';
import type { ExecutionAdapter } from './adapters/interface.js';
import { JobQueueAdapter } from './adapters/job-queue.js';
import { LocalFunctionAdapter, type LocalFunction } from './adapters/local-fn.js';
import { McpSamplingAdapter, type McpSamplingFn } from './adapters/mcp-sampling.js';
import { SubprocessAdapter } from './adapters/subprocess.js';
import { WebhookAdapter } from './adapters/webhook.js';
import type { ProviderCapabilityConfig, ProviderConfig } from './capabilities.js';
import { TaskQueue } from './task-queue.js';

const logger = pino({ name: '@hivemind-os/collective-daemon:provider' });
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
  private _jobQueue?: JobQueueAdapter;

  constructor(
    private readonly params: {
      state: DaemonState;
      providerConfig: ProviderConfig;
      cursorDbPath: string;
      jobQueueDbPath: string;
      relayConfig?: DaemonFullConfig['relay'];
      relayClientFactory?: (config: RelayClientConfig, identity: DaemonState['relayAuthProvider']) => RelayClient;
      mcpSamplingFn?: McpSamplingFn;
      broadcastNotification?: (method: string, params?: unknown) => void;
    },
  ) {
    this.taskQueue = new TaskQueue(params.providerConfig.maxConcurrency);
  }

  get jobQueue(): JobQueueAdapter | undefined {
    return this._jobQueue;
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
    this._jobQueue?.close();
    this._jobQueue = undefined;
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

    // Notify connected MCP clients of inbound task request
    this.params.broadcastNotification?.('notifications/mesh/inbound_task', {
      taskId: event.task.id,
      capability: event.task.capability,
      requester: event.task.requester,
      priceMist: event.task.price.toString(),
    });

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

    const hasJobQueue = this.params.providerConfig.capabilities.some((c) => c.adapter === 'job-queue');
    if (hasJobQueue && !this._jobQueue) {
      this._jobQueue = new JobQueueAdapter({ dbPath: this.params.jobQueueDbPath });
    }

    const deps: AdapterDeps = {
      mcpSamplingFn: this.params.mcpSamplingFn,
      jobQueue: this._jobQueue,
    };

    for (const capability of this.params.providerConfig.capabilities) {
      try {
        const key = normalizeCapability(capability.name);
        const adapter = createAdapter(capability, deps);
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

interface AdapterDeps {
  mcpSamplingFn?: McpSamplingFn;
  jobQueue?: JobQueueAdapter;
}

function createAdapter(capability: ProviderCapabilityConfig, deps: AdapterDeps): ExecutionAdapter {
  const config = capability.adapterConfig ?? {};

  switch (capability.adapter) {
    case 'echo':
      return new EchoAdapter();
    case 'job-queue': {
      if (!deps.jobQueue) {
        throw new Error('Job queue adapter was not initialized.');
      }
      return deps.jobQueue;
    }
    case 'local-function': {
      const fnCandidate = config.fn ?? config.function;
      if (typeof fnCandidate !== 'function') {
        throw new Error(`Capability ${capability.name} is missing a local function adapter.`);
      }
      return new LocalFunctionAdapter(fnCandidate as LocalFunction);
    }
    case 'webhook':
      return new WebhookAdapter({
        url: requireString(config.url, 'webhook url'),
        method: optionalString(config.method),
        headers: optionalStringRecord(config.headers),
        timeoutMs: optionalNumber(config.timeoutMs),
        maxResponseBytes: optionalNumber(config.maxResponseBytes),
      });
    case 'subprocess':
      return new SubprocessAdapter({
        command: requireString(config.command, 'subprocess command'),
        args: optionalStringArray(config.args),
        cwd: optionalString(config.cwd),
        env: optionalStringRecord(config.env),
        timeoutMs: optionalNumber(config.timeoutMs),
        maxOutputBytes: optionalNumber(config.maxOutputBytes),
      });
    case 'mcp-sampling': {
      if (!deps.mcpSamplingFn) {
        throw new Error('MCP sampling adapter requires an active IPC server with sampling support.');
      }
      return new McpSamplingAdapter(
        {
          appName: requireString(config.appName, 'mcp-sampling appName'),
          systemPrompt: requireString(config.systemPrompt, 'mcp-sampling systemPrompt'),
          maxTokens: optionalNumber(config.maxTokens),
          modelHint: optionalString(config.modelHint),
        },
        deps.mcpSamplingFn,
      );
    }
    default:
      throw new Error(`Unsupported execution adapter: ${capability.adapter}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required config field: ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
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
