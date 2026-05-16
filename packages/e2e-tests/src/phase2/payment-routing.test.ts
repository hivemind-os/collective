import { afterAll, describe, expect, it, vi } from 'vitest';

import { PaymentRailSelector } from '@hivemind-os/collective-core';
import { PaymentRail, TaskStatus, type AgentCard } from '@hivemind-os/collective-types';

import { PortAllocator } from '../harness/index.js';
import { createArtifactRoot, removeDirectoryWithRetries } from '../phase1/test-helpers.js';
import { connectTestProvider, createTestIdentity, startTestRelay } from './test-helpers.js';

const selector = new PaymentRailSelector();
let artifactRoot: string;

interface MeshExecuteParams {
  capability: string;
  input: string;
  mode?: 'sync' | 'async';
}

interface MeshExecuteResult {
  execution_mode: string;
  payment_rail: PaymentRail;
  provider_did?: string;
  result: string;
  task_id?: string;
}

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
});

describe('Phase 2 E2E: Payment Rail Selection', () => {
  it('async task always selects Sui escrow', () => {
    expect(
      selector.selectRail({
        executionMode: 'async',
        consumerHasSuiWallet: true,
        consumerHasEvmWallet: true,
        providerAcceptsSui: true,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('sui-escrow');
  });

  it('sync task prefers Sui when both parties support it', () => {
    expect(
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: true,
        consumerHasEvmWallet: true,
        providerAcceptsSui: true,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('sui-transfer');
  });

  it('sync task uses x402 when the consumer only has EVM', () => {
    expect(
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: false,
        consumerHasEvmWallet: true,
        providerAcceptsSui: false,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toBe('x402-base');
  });

  it('sync task throws when no matching rails are available', () => {
    expect(() =>
      selector.selectRail({
        executionMode: 'sync',
        consumerHasSuiWallet: true,
        consumerHasEvmWallet: false,
        providerAcceptsSui: false,
        providerAcceptsX402: true,
        amount: 1n,
        currency: 'USDC',
      }),
    ).toThrow('No compatible payment rail is available for this task.');
  });

  it('collective_execute selects relay sync flow when provider capabilities support it', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-payment-routing');
    const relayServer = await startTestRelay({ artifactRoot, name: 'routing-sync' });
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { echo: message.input, mode: 'sync' });
      },
    });
    const consumer = createTestIdentity();
    const taskClient = {
      postTask: vi.fn(),
      getTask: vi.fn(),
      releasePayment: vi.fn(),
    };
    const context = createContext(createAgent(provider.identity.did, relayServer.httpUrl), consumer, {
      taskClient,
    });
    const { runMeshExecute } = await loadRunMeshExecute();

    try {
      const result = await runMeshExecute({ capability: 'echo', input: 'sync via relay', mode: 'sync' }, context);

      expect(result.execution_mode).toBe('sync');
      expect(result.payment_rail).toBe(PaymentRail.SUI_TRANSFER);
      expect(result.provider_did).toBe(provider.identity.did);
      expect(JSON.parse(result.result)).toEqual({ echo: 'sync via relay', mode: 'sync' });
      expect(taskClient.postTask).not.toHaveBeenCalled();
      expect(context.spendingPolicy.record).toHaveBeenCalledWith(
        expect.objectContaining({ rail: PaymentRail.SUI_TRANSFER, appId: provider.identity.did }),
      );
    } finally {
      await provider.close().catch(() => undefined);
      await relayServer.stop();
    }
  });

  it('falls back to transparent async execution when the relay is unavailable', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-payment-routing');
    const allocator = new PortAllocator();
    const [unusedPort] = await allocator.allocate(1);
    const consumer = createTestIdentity();
    const taskClient = {
      postTask: vi.fn(async () => ({ taskId: 'async-task-1' })),
      getTask: vi.fn(async () => ({ status: TaskStatus.COMPLETED, resultBlobId: 'blob-out' })),
      releasePayment: vi.fn(async () => undefined),
    };
    const blobStore = {
      store: vi.fn(async () => ({ blobId: 'blob-in' })),
      fetch: vi.fn(async () => new TextEncoder().encode('async fallback result')),
    };
    const context = createContext(createAgent(createTestIdentity().did, `http://127.0.0.1:${unusedPort}`), consumer, {
      taskClient,
      blobStore,
    });
    const { runMeshExecute } = await loadRunMeshExecute();

    try {
      const result = await runMeshExecute({ capability: 'echo', input: 'fallback to async' }, context);

      expect(result.execution_mode).toBe('async');
      expect(result.task_id).toBe('async-task-1');
      expect(result.result).toBe('async fallback result');
      expect(result.payment_rail).toBe(PaymentRail.SUI_ESCROW);
      expect(taskClient.postTask).toHaveBeenCalledOnce();
      expect(taskClient.releasePayment).toHaveBeenCalledOnce();
      expect(context.logger.warn).toHaveBeenCalledOnce();
    } finally {
      await allocator.release([unusedPort]);
    }
  });
});

function createAgent(providerDid: AgentCard['did'], relayUrl: string): AgentCard {
  return {
    id: `agent-${providerDid}`,
    owner: 'owner',
    did: providerDid,
    name: 'Relay Provider',
    description: 'Phase 2 relay-backed provider',
    active: true,
    version: 1,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
    endpoint: relayUrl,
    relayEndpoints: [{ endpoint: relayUrl, modes: ['sync', 'fallback'] }],
    capabilities: [
      {
        name: 'echo',
        description: 'Echo capability',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 5n,
          currency: 'MIST',
        },
        executionMode: 'sync',
        paymentRails: [PaymentRail.SUI_TRANSFER, PaymentRail.X402_BASE, PaymentRail.SUI_ESCROW],
      },
    ],
  };
}

function createContext(
  agent: AgentCard,
  consumer: ReturnType<typeof createTestIdentity>,
  overrides: {
    taskClient?: Record<string, unknown>;
    blobStore?: Record<string, unknown>;
  } = {},
) {
  const taskClient =
    overrides.taskClient ??
    ({
      postTask: vi.fn(async () => ({ taskId: 'unused-task' })),
      getTask: vi.fn(async () => ({ status: TaskStatus.COMPLETED, resultBlobId: 'unused-blob' })),
      releasePayment: vi.fn(async () => undefined),
    } satisfies Record<string, unknown>);
  const blobStore =
    overrides.blobStore ??
    ({
      store: vi.fn(async () => ({ blobId: 'unused-in' })),
      fetch: vi.fn(async () => new TextEncoder().encode('unused result')),
    } satisfies Record<string, unknown>);

  return {
    did: consumer.did,
    keypair: consumer.keypair,
    blobStore,
    taskClient,
    agentCache: {
      searchByCapability: vi.fn(() => [agent]),
      getAgentByDID: vi.fn((did: string) => (did === agent.did ? agent : undefined)),
      upsertAgent: vi.fn(),
    },
    registryClient: {
      discoverByCapability: vi.fn(async () => []),
    },
    spendingPolicy: {
      evaluate: vi.fn(() => ({ approved: true })),
      record: vi.fn(),
    },
    networkConfig: {},
    relayAuthProvider: consumer.authProvider,
    logger: {
      warn: vi.fn(),
    },
  };
}

async function loadRunMeshExecute(): Promise<{
  runMeshExecute: (params: MeshExecuteParams, context: ReturnType<typeof createContext>) => Promise<MeshExecuteResult>;
}> {
  return import(
    /* @vite-ignore */ new URL('../../../mcp-server/src/tools/execute.ts', import.meta.url).href
  ) as Promise<{
    runMeshExecute: (params: MeshExecuteParams, context: ReturnType<typeof createContext>) => Promise<MeshExecuteResult>;
  }>;
}
