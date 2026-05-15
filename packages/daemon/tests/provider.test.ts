import { createHash } from 'node:crypto';

import type { SuiEvent } from '@mysten/sui/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    params: {
      eventType: string;
      pollIntervalMs?: number;
      onEvent: (event: SuiEvent) => Promise<void>;
      onError?: (error: unknown) => void;
    };
    started: boolean;
    stopped: boolean;
    emit: (event: SuiEvent) => Promise<void>;
  }>,
  cursorStores: [] as Array<{ dbPath: string; closed: boolean }>,
}));

vi.mock('@agentic-mesh/core', async () => {
  const actual = await vi.importActual<typeof import('@agentic-mesh/core')>('@agentic-mesh/core');

  class MockEventSubscription {
    readonly params: {
      eventType: string;
      pollIntervalMs?: number;
      onEvent: (event: SuiEvent) => Promise<void>;
      onError?: (error: unknown) => void;
    };

    started = false;
    stopped = false;

    constructor(params: {
      eventType: string;
      pollIntervalMs?: number;
      onEvent: (event: SuiEvent) => Promise<void>;
      onError?: (error: unknown) => void;
    }) {
      this.params = params;
      providerMocks.subscriptions.push(this as unknown as (typeof providerMocks.subscriptions)[number]);
    }

    start(): void {
      this.started = true;
    }

    stop(): void {
      this.stopped = true;
    }

    async emit(event: SuiEvent): Promise<void> {
      await this.params.onEvent(event);
    }
  }

  class MockSqliteCursorStore {
    readonly dbPath: string;
    closed = false;

    constructor(dbPath: string) {
      this.dbPath = dbPath;
      providerMocks.cursorStores.push(this as unknown as (typeof providerMocks.cursorStores)[number]);
    }

    async getCursor(): Promise<null> {
      return null;
    }

    async setCursor(): Promise<void> {
      return undefined;
    }

    close(): void {
      this.closed = true;
    }
  }

  return {
    ...actual,
    EventSubscription: MockEventSubscription,
    SqliteCursorStore: MockSqliteCursorStore,
  };
});

import { parseMeteredResultEnvelope } from '@agentic-mesh/core';
import { PaymentScheme, type DID } from '@agentic-mesh/types';

import type { DaemonFullConfig } from '../src/config.js';
import { getDefaultConfig } from '../src/config.js';
import { EchoAdapter, ProviderRuntime, TaskQueue, loadProviderConfig } from '../src/provider/index.js';
import type { DaemonState } from '../src/state.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('EchoAdapter', () => {
  it('returns the expected echo payload with a hash', async () => {
    const adapter = new EchoAdapter();
    const inputData = encoder.encode('hello world');

    const result = await adapter.execute({
      taskId: 'task-1',
      capability: 'echo-capability',
      inputData,
    });

    const parsed = JSON.parse(decoder.decode(result.resultData)) as {
      echo: string;
      taskId: string;
      capability: string;
      timestamp: number;
      inputHash: string;
    };

    expect(parsed).toMatchObject({
      echo: 'hello world',
      taskId: 'task-1',
      capability: 'echo-capability',
      inputHash: createHash('sha256').update(inputData).digest('hex'),
    });
    expect(parsed.timestamp).toBeTypeOf('number');
  });
});

describe('TaskQueue', () => {
  it('respects maxConcurrency', async () => {
    const queue = new TaskQueue(1);
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await expect(
      queue.enqueue('task-1', async () => {
        started.push('task-1');
        await firstDone;
      }),
    ).resolves.toBe(true);
    await expect(
      queue.enqueue('task-2', async () => {
        started.push('task-2');
      }),
    ).resolves.toBe(false);
    await expect(
      queue.enqueue('task-3', async () => {
        started.push('task-3');
      }),
    ).resolves.toBe(false);

    expect(started).toEqual(['task-1']);
    releaseFirst();
    await queue.drain();

    await expect(
      queue.enqueue('task-4', async () => {
        started.push('task-4');
      }),
    ).resolves.toBe(true);
    await queue.drain();

    expect(started).toEqual(['task-1', 'task-4']);
  });

  it('reports when the queue is full', async () => {
    const queue = new TaskQueue(1);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(queue.isFull).toBe(false);
    await queue.enqueue('task-1', async () => {
      await blocker;
    });
    expect(queue.isFull).toBe(true);

    release();
    await queue.drain();
    expect(queue.isFull).toBe(false);
  });

  it('drains running work before returning', async () => {
    const queue = new TaskQueue(1);
    let completed = false;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    await queue.enqueue('task-1', async () => {
      await blocker;
      completed = true;
    });

    const draining = queue.drain();
    expect(completed).toBe(false);

    release();
    await draining;

    expect(completed).toBe(true);
    expect(queue.activeCount).toBe(0);
  });
});

describe('loadProviderConfig', () => {
  it('returns provider config when present', () => {
    const defaults = getDefaultConfig();
    const config: DaemonFullConfig = {
      ...defaults,
      provider: {
        enabled: true,
        maxConcurrency: 3,
        autoRegister: true,
        capabilities: [
          {
            name: 'echo',
            description: 'Echo input',
            version: '1.0.0',
            priceMist: 42,
            currency: 'MIST',
            adapter: 'echo',
          },
        ],
      },
    };

    expect(loadProviderConfig(config)).toEqual({
      enabled: true,
      maxConcurrency: 3,
      autoRegister: true,
      capabilities: [
        {
          name: 'echo',
          description: 'Echo input',
          version: '1.0.0',
          priceMist: 42,
          currency: 'MIST',
          adapter: 'echo',
        },
      ],
    });
  });

  it('returns null when provider config is missing', () => {
    expect(loadProviderConfig(getDefaultConfig())).toBeNull();
  });
});

describe('ProviderRuntime', () => {
  beforeEach(() => {
    providerMocks.subscriptions.length = 0;
    providerMocks.cursorStores.length = 0;
  });

  it('filters events by capability and processes matching tasks', async () => {
    const state = createRuntimeState();
    const runtime = new ProviderRuntime({
      state,
      providerConfig: {
        enabled: true,
        maxConcurrency: 1,
        autoRegister: false,
        capabilities: [
          {
            name: 'echo-capability',
            description: 'Echo input',
            version: '1.0.0',
            priceMist: 1,
            adapter: 'echo',
          },
        ],
      },
      cursorDbPath: 'provider-cursors.db',
    });

    await runtime.start();

    const subscription = providerMocks.subscriptions[0];
    expect(subscription?.started).toBe(true);
    expect(subscription?.params.eventType).toBe('0xpackage::task::TaskPosted');
    expect(subscription?.params.pollIntervalMs).toBe(2000);

    await subscription.emit(createTaskPostedEvent({ taskId: 'task-1', capability: 'echo-capability', blobId: 'blob-1' }));
    await subscription.emit(createTaskPostedEvent({ taskId: 'task-2', capability: 'other-capability', blobId: 'blob-2' }));
    await runtime.stop();

    expect(state.taskClient.acceptTask).toHaveBeenCalledTimes(1);
    expect(state.taskClient.acceptTask).toHaveBeenCalledWith({ taskId: 'task-1', keypair: state.keypair });
    expect(state.blobStore.fetch).toHaveBeenCalledTimes(1);
    expect(state.blobStore.fetch).toHaveBeenCalledWith('blob-1');
    expect(state.blobStore.store).toHaveBeenCalledTimes(1);
    expect(state.taskClient.completeTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      resultBlobId: 'result-blob',
      keypair: state.keypair,
      providerCardId: '0xprovider-card',
    });
    expect(providerMocks.cursorStores[0]?.dbPath).toBe('provider-cursors.db');
    expect(providerMocks.cursorStores[0]?.closed).toBe(true);
  });

  it('decrypts encrypted inputs and encrypts results when keys are available', async () => {
    const state = createRuntimeState();
    state.encryption = { enabled: true, requireEncryption: false } as never;
    state.blobStore = {
      fetch: vi.fn().mockResolvedValue(
        encoder.encode(JSON.stringify({
          version: 1,
          senderPublicKey: '11'.repeat(32),
          nonce: '22'.repeat(24),
          ciphertext: '33'.repeat(16),
          tag: '33'.repeat(16),
        })),
      ),
      fetchDecrypted: vi.fn().mockResolvedValue(encoder.encode('payload')),
      store: vi.fn(),
      storeEncrypted: vi.fn().mockResolvedValue({ blobId: 'encrypted-result', hash: 'hash-1' }),
    } as never;
    state.registryClient.getAgentCardByOwner = vi.fn().mockResolvedValue({ encryptionPublicKey: '44'.repeat(32) }) as never;
    const runtime = new ProviderRuntime({
      state,
      providerConfig: {
        enabled: true,
        maxConcurrency: 1,
        autoRegister: false,
        capabilities: [
          {
            name: 'echo-capability',
            description: 'Echo input',
            version: '1.0.0',
            priceMist: 1,
            adapter: 'echo',
          },
        ],
      },
      cursorDbPath: 'provider-cursors.db',
    });

    await runtime.start();

    const subscription = providerMocks.subscriptions[0];
    await subscription.emit(createTaskPostedEvent({ taskId: 'task-enc', capability: 'echo-capability', blobId: 'blob-enc' }));
    await runtime.stop();

    expect((state.blobStore as { fetchDecrypted: ReturnType<typeof vi.fn> }).fetchDecrypted).toHaveBeenCalledWith('blob-enc');
    expect((state.blobStore as { storeEncrypted: ReturnType<typeof vi.fn> }).storeEncrypted).toHaveBeenCalledTimes(1);
    expect(state.taskClient.completeTask).toHaveBeenCalledWith({
      taskId: 'task-enc',
      resultBlobId: 'encrypted-result',
      keypair: state.keypair,
      providerCardId: '0xprovider-card',
    });
  });

  it('completes metered tasks with verification data', async () => {
    const state = createRuntimeState();
    const runtime = new ProviderRuntime({
      state,
      providerConfig: {
        enabled: true,
        maxConcurrency: 1,
        autoRegister: false,
        capabilities: [
          {
            name: 'echo-capability',
            description: 'Echo input',
            version: '1.0.0',
            priceMist: 1,
            adapter: 'echo',
          },
        ],
      },
      cursorDbPath: 'provider-cursors.db',
    });

    await runtime.start();

    const subscription = providerMocks.subscriptions[0];
    await subscription.emit(createTaskPostedEvent({
      taskId: 'task-metered',
      capability: 'echo-capability',
      blobId: 'blob-metered',
      paymentScheme: PaymentScheme.UPTO,
      maxPrice: '10',
      unitPrice: '1',
    }));
    await runtime.stop();

    expect(state.taskClient.completeMeteredTask).toHaveBeenCalledTimes(1);
    expect(state.taskClient.completeTask).not.toHaveBeenCalled();
    expect(state.taskClient.completeMeteredTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-metered',
      resultBlobId: 'result-blob',
      meteredUnits: expect.any(Number),
      verificationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      keypair: state.keypair,
      providerCardId: '0xprovider-card',
    }));
    const storedPayload = await (state.blobStore.store as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const envelope = parseMeteredResultEnvelope(storedPayload as Uint8Array);
    expect(envelope).not.toBeNull();
    expect(envelope?.proof.root).toBe((state.taskClient.completeMeteredTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.verificationHash);
  });

  it('ignores non-matching capabilities', async () => {
    const state = createRuntimeState();
    const runtime = new ProviderRuntime({
      state,
      providerConfig: {
        enabled: true,
        maxConcurrency: 1,
        autoRegister: false,
        capabilities: [
          {
            name: 'echo-capability',
            description: 'Echo input',
            version: '1.0.0',
            priceMist: 1,
            adapter: 'echo',
          },
        ],
      },
      cursorDbPath: 'provider-cursors.db',
    });

    await runtime.start();

    const subscription = providerMocks.subscriptions[0];
    await subscription.emit(createTaskPostedEvent({ taskId: 'task-9', capability: 'missing-capability', blobId: 'blob-9' }));
    await runtime.stop();

    expect(state.taskClient.acceptTask).not.toHaveBeenCalled();
    expect(state.blobStore.fetch).not.toHaveBeenCalled();
    expect(state.taskClient.completeTask).not.toHaveBeenCalled();
    expect(state.taskClient.completeMeteredTask).not.toHaveBeenCalled();
  });
});

function createRuntimeState(): DaemonState {
  return {
    did: 'did:mesh:test-provider' as DID,
    keypair: { name: 'keypair' },
    network: { packageId: '0xpackage' },
    suiClient: { name: 'sui-client' },
    registryClient: {
      registerAgent: vi.fn(),
      getAgentCard: vi.fn(),
      getAgentCardByOwner: vi.fn().mockResolvedValue(null),
      findAgentByDid: vi.fn().mockResolvedValue({ id: '0xprovider-card' }),
    },
    agentCache: {
      upsertAgent: vi.fn(),
      getAgentByDID: vi.fn().mockReturnValue({ id: '0xprovider-card' }),
    },
    taskClient: {
      acceptTask: vi.fn().mockResolvedValue({ txDigest: '0xaccept' }),
      completeTask: vi.fn().mockResolvedValue({ txDigest: '0xcomplete' }),
      completeMeteredTask: vi.fn().mockResolvedValue({ txDigest: '0xcomplete-metered' }),
    },
    blobStore: {
      fetch: vi.fn().mockResolvedValue(encoder.encode('payload')),
      store: vi.fn().mockResolvedValue({ blobId: 'result-blob', checksum: 'checksum' }),
    },
    encryption: {
      enabled: false,
      requireEncryption: false,
    },
  } as unknown as DaemonState;
}

function createTaskPostedEvent(params: {
  taskId: string;
  capability: string;
  blobId: string;
  paymentScheme?: PaymentScheme;
  maxPrice?: string;
  meteredUnits?: number;
  unitPrice?: string;
  verificationHash?: string;
}): SuiEvent {
  return {
    id: {
      txDigest: `0x${params.taskId}`,
      eventSeq: '1',
    },
    packageId: '0xpackage',
    transactionModule: 'task',
    sender: '0xrequester',
    type: '0xpackage::task::TaskPosted',
    parsedJson: {
      task_id: params.taskId,
      requester: '0xrequester',
      capability: params.capability,
      input_blob_id: params.blobId,
      price: '1',
      payment_scheme: params.paymentScheme,
      max_price: params.maxPrice,
      metered_units: params.meteredUnits,
      unit_price: params.unitPrice,
      verification_hash: params.verificationHash ? Array.from(Buffer.from(params.verificationHash, 'hex')) : undefined,
      status: 0,
      dispute_window_ms: 0,
      created_at: 100,
      expires_at: 200,
    },
    bcs: '',
    timestampMs: '100',
  } as unknown as SuiEvent;
}
