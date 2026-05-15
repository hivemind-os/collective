import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, TaskStatus, type AgentCard, type Task } from '@agentic-mesh/types';

import type { MeshToolContext } from '../src/context.js';
import { runMeshExecute } from '../src/tools/execute.js';

function createAgent(): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xprovider',
    did: 'did:mesh:provider-1' as AgentCard['did'],
    name: 'Summarizer',
    description: 'Summarizes text',
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarize documents',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 100n,
          currency: 'MIST',
        },
      },
    ],
    endpoint: 'mesh://agent/did:mesh:provider-1',
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '0xtask-1',
    requester: '0xrequester',
    provider: '0xprovider',
    capability: 'summarize',
    inputBlobId: 'blob-input',
    resultBlobId: 'blob-output',
    price: 100n,
    status: TaskStatus.COMPLETED,
    disputeWindowMs: 60_000,
    createdAt: 1_000,
    acceptedAt: 1_500,
    completedAt: 2_000,
    expiresAt: 3_000,
    agreementHash: undefined,
    ...overrides,
  };
}

function createContext(overrides: Partial<MeshToolContext> = {}): MeshToolContext {
  const agent = createAgent();

  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {} as MeshToolContext['keypair'],
    suiClient: {
      getBalance: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as MeshToolContext['suiClient'],
    registryClient: {
      discoverByCapability: vi.fn().mockResolvedValue([]),
      getAgentCard: vi.fn(),
    } as unknown as MeshToolContext['registryClient'],
    taskClient: {
      postTask: vi.fn().mockResolvedValue({ taskId: '0xtask-1', txDigest: '0xtx-1' }),
      getTask: vi.fn().mockResolvedValue(createTask()),
      releasePayment: vi.fn().mockResolvedValue({ txDigest: '0xtx-2' }),
    } as unknown as MeshToolContext['taskClient'],
    agentCache: {
      searchByCapability: vi.fn().mockReturnValue([agent]),
      getAgentByDID: vi.fn().mockReturnValue(agent),
      getAllActive: vi.fn().mockReturnValue([agent]),
      upsertAgent: vi.fn(),
      removeAgent: vi.fn(),
    } as unknown as MeshToolContext['agentCache'],
    blobStore: {
      store: vi.fn().mockResolvedValue({ blobId: 'blob-input', checksum: 'sha256' }),
      fetch: vi.fn().mockResolvedValue(new TextEncoder().encode('done')),
    } as unknown as MeshToolContext['blobStore'],
    spendingPolicy: {
      evaluate: vi.fn().mockReturnValue({ approved: true }),
      record: vi.fn(),
    } as unknown as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    ...overrides,
  };
}

describe('runMeshExecute', () => {
  it('completes the happy path', async () => {
    const context = createContext();

    const result = await runMeshExecute(
      {
        capability: 'summarize',
        input: 'hello',
      },
      context,
    );

    expect(result).toEqual({
      task_id: '0xtask-1',
      result: 'done',
      provider_did: 'did:mesh:provider-1',
      price_mist: '100',
      status: 'RELEASED',
    });
    expect(context.taskClient.postTask).toHaveBeenCalled();
    expect(context.taskClient.releasePayment).toHaveBeenCalledWith({
      taskId: '0xtask-1',
      keypair: context.keypair,
    });
    expect(context.spendingPolicy.record).toHaveBeenCalledWith({
      amountMist: 100n,
      rail: PaymentRail.SUI_ESCROW,
      taskId: '0xtask-1',
      appId: 'did:mesh:provider-1',
    });
  });

  it('throws when spending policy rejects the task', async () => {
    const context = createContext({
      spendingPolicy: {
        evaluate: vi.fn().mockReturnValue({ approved: false, reason: 'Denied by policy' }),
        record: vi.fn(),
      } as unknown as MeshToolContext['spendingPolicy'],
    });

    await expect(
      runMeshExecute(
        {
          capability: 'summarize',
          input: 'hello',
        },
        context,
      ),
    ).rejects.toThrow('Denied by policy');
  });

  it('throws on timeout', async () => {
    const context = createContext({
      taskClient: {
        postTask: vi.fn().mockResolvedValue({ taskId: '0xtask-1', txDigest: '0xtx-1' }),
        getTask: vi.fn().mockResolvedValue(createTask({ status: TaskStatus.OPEN, resultBlobId: undefined })),
        releasePayment: vi.fn(),
      } as unknown as MeshToolContext['taskClient'],
    });

    await expect(
      runMeshExecute(
        {
          capability: 'summarize',
          input: 'hello',
          timeout_seconds: 0,
        },
        context,
      ),
    ).rejects.toThrow('Timed out waiting for task 0xtask-1 to complete.');
  });

  it('throws when no provider is found', async () => {
    const context = createContext({
      agentCache: {
        searchByCapability: vi.fn().mockReturnValue([]),
        getAgentByDID: vi.fn().mockReturnValue(null),
        getAllActive: vi.fn().mockReturnValue([]),
        upsertAgent: vi.fn(),
        removeAgent: vi.fn(),
      } as unknown as MeshToolContext['agentCache'],
      registryClient: {
        discoverByCapability: vi.fn().mockResolvedValue([]),
        getAgentCard: vi.fn(),
      } as unknown as MeshToolContext['registryClient'],
    });

    await expect(
      runMeshExecute(
        {
          capability: 'summarize',
          input: 'hello',
        },
        context,
      ),
    ).rejects.toThrow('No providers found for capability summarize.');
  });
});
