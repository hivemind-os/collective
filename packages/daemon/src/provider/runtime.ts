import pino from 'pino';

import { EventSubscription, SqliteCursorStore, parseRawEvent } from '@agentic-mesh/core';
import { PaymentRail, type Capability, type TaskPostedEvent } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';

import type { DaemonState } from '../state.js';
import { EchoAdapter } from './adapters/echo.js';
import type { ExecutionAdapter } from './adapters/interface.js';
import { LocalFunctionAdapter, type LocalFunction } from './adapters/local-fn.js';
import type { ProviderCapabilityConfig, ProviderConfig } from './capabilities.js';
import { TaskQueue } from './task-queue.js';

const logger = pino({ name: '@agentic-mesh/daemon:provider' });

export class ProviderRuntime {
  private subscription?: EventSubscription;
  private cursorStore?: SqliteCursorStore;
  private readonly taskQueue: TaskQueue;
  private readonly adapters = new Map<string, ExecutionAdapter>();
  private readonly capabilityConfigs = new Map<string, ProviderCapabilityConfig>();
  private registeredCapabilities: string[] = [];
  private chainOperations: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: {
      state: DaemonState;
      providerConfig: ProviderConfig;
      cursorDbPath: string;
    },
  ) {
    this.taskQueue = new TaskQueue(params.providerConfig.maxConcurrency);
  }

  async start(): Promise<void> {
    if (this.subscription) {
      return;
    }

    this.initializeAdapters();

    if (this.params.providerConfig.autoRegister) {
      await this.registerAgentCard();
    }

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
    await this.taskQueue.drain();
    this.cursorStore?.close();
    this.cursorStore = undefined;
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
        await this.processTask(event.task.id, event.task.capability, event.task.inputBlobId);
      } catch (error) {
        logger.error({ err: error, taskId: event.task.id }, 'Task processing failed');
      }
    });

    if (!queued) {
      logger.warn({ taskId: event.task.id }, 'Task was not queued');
    }
  }

  private async processTask(taskId: string, capability: string, inputBlobId: string): Promise<void> {
    const adapter = this.adapters.get(normalizeCapability(capability));
    if (!adapter) {
      throw new Error(`No adapter configured for capability ${capability}.`);
    }

    await this.runChainOperation(async () => {
      await this.params.state.taskClient.acceptTask({
        taskId,
        keypair: this.params.state.keypair,
      });
    });

    const inputData = await this.params.state.blobStore.fetch(inputBlobId);
    if (!inputData) {
      throw new Error(`Input blob ${inputBlobId} was not found.`);
    }

    const result = await adapter.execute({
      taskId,
      capability,
      inputData,
    });
    const storedResult = await this.params.state.blobStore.store(result.resultData);

    await this.runChainOperation(async () => {
      await this.params.state.taskClient.completeTask({
        taskId,
        resultBlobId: storedResult.blobId,
        keypair: this.params.state.keypair,
      });
    });
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
    const capabilities = this.params.providerConfig.capabilities
      .filter((capability) => this.capabilityConfigs.has(normalizeCapability(capability.name)))
      .map(toCapability);

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
        endpoint: `mesh://agent/${this.params.state.did}`,
        keypair: this.params.state.keypair,
      });
      const card = await this.params.state.registryClient.getAgentCard(registration.agentCardId);
      if (card) {
        this.params.state.agentCache.upsertAgent(card);
      }
      logger.info({ agentCardId: registration.agentCardId }, 'Provider agent card registered');
    } catch (error) {
      logger.error({ err: error }, 'Provider auto-registration failed');
    }
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

function toCapability(capability: ProviderCapabilityConfig): Capability {
  return {
    name: capability.name,
    description: capability.description,
    version: capability.version,
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: BigInt(capability.priceMist),
      currency: capability.currency ?? 'MIST',
    },
  };
}

function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase();
}
