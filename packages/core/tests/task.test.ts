import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { PaymentScheme, TaskClient, TaskStatus, type MeshSuiClient } from '../src/index.js';

const networkConfig = {
  rpcUrl: 'http://127.0.0.1:9000',
  faucetUrl: 'http://127.0.0.1:9123',
  packageId: '0x1',
  registryId: '0x2',
};

function getCommands(tx: { getData: () => { commands: Array<Record<string, unknown>> } }): Array<Record<string, unknown>> {
  return tx.getData().commands;
}

describe('TaskClient', () => {
  it('builds a post task transaction with split coins', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({
      digest: '0xtx',
      objectChanges: [
        {
          type: 'created',
          objectType: '0x1::task::Task',
          objectId: '0x3',
        },
      ],
    });
    const client = new TaskClient(
      {
        executeTransaction,
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const result = await client.postTask({
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      agreementHash: 'hash-1',
      priceMist: 500n,
      disputeWindowMs: 60_000,
      expiryHours: 24,
      keypair: {} as unknown as Ed25519Keypair,
    });

    const commands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    const kinds = commands.map((command) => String(command.$kind));

    expect(kinds).toContain('SplitCoins');
    expect(kinds).toContain('MoveCall');
    expect(result).toEqual({ txDigest: '0xtx', taskId: '0x3' });
  });

  it('builds an accept task transaction', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({ digest: '0xtx' });
    const client = new TaskClient(
      {
        executeTransaction,
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await client.acceptTask({
      taskId: '0x3',
      keypair: {} as unknown as Ed25519Keypair,
    });

    const commands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    expect(commands[0]?.$kind).toBe('MoveCall');
  });

  it('builds metered task lifecycle transactions', async () => {
    const executeTransaction = vi.fn()
      .mockResolvedValueOnce({
        digest: '0xpost',
        objectChanges: [
          {
            type: 'created',
            objectType: '0x1::task::Task',
            objectId: '0x9',
          },
        ],
      })
      .mockResolvedValueOnce({ digest: '0xcomplete' })
      .mockResolvedValueOnce({ digest: '0xrelease' });
     const client = new TaskClient(
      {
        executeTransaction,
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const posted = await client.postMeteredTask({
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      agreementHash: 'hash-1',
      maxPriceMist: 900n,
      unitPriceMist: 300n,
      disputeWindowMs: 60_000,
      expiryHours: 24,
      keypair: {} as unknown as Ed25519Keypair,
    });
    await client.completeMeteredTask({
      taskId: '0x9',
      resultBlobId: 'blob-2',
      meteredUnits: 2,
      verificationHash: 'aa'.repeat(32),
      keypair: {} as unknown as Ed25519Keypair,
    });
    await client.releaseMeteredPayment({
      taskId: '0x9',
      keypair: {} as unknown as Ed25519Keypair,
    });

    expect(posted).toEqual({ txDigest: '0xpost', taskId: '0x9' });
    const postCommands = getCommands(executeTransaction.mock.calls[0]?.[0]);
    expect(postCommands.map((command) => String(command.$kind))).toContain('SplitCoins');
    const completeCommands = getCommands(executeTransaction.mock.calls[1]?.[0]);
    expect(completeCommands[0]?.$kind).toBe('MoveCall');
    const releaseCommands = getCommands(executeTransaction.mock.calls[2]?.[0]);
    expect(releaseCommands[0]?.$kind).toBe('MoveCall');
  });

  it('parses task objects', async () => {
    const client = new TaskClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          id: '0xtask',
          requester: '0xrequester',
          provider: '0x0',
          capability: 'summarize',
          category: 'analysis',
          input_blob_id: 'blob-1',
          price: '500',
          status: 0,
          dispute_window_ms: 60_000,
          created_at: 1_000,
          expires_at: 2_000,
          agreement_hash: 'hash-1',
        }),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const task = await client.getTask('0xtask');

    expect(task).toEqual({
      id: '0xtask',
      requester: '0xrequester',
      provider: undefined,
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      resultBlobId: undefined,
      price: 500n,
      paymentScheme: undefined,
      maxPrice: undefined,
      meteredUnits: undefined,
      unitPrice: undefined,
      verificationHash: undefined,
      status: TaskStatus.OPEN,
      disputeWindowMs: 60_000,
      createdAt: 1_000,
      acceptedAt: undefined,
      completedAt: undefined,
      expiresAt: 2_000,
      agreementHash: 'hash-1',
    });
  });

  it('parses metered task objects', async () => {
    const client = new TaskClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          id: '0xmetered',
          requester: '0xrequester',
          provider: '0xprovider',
          capability: 'summarize',
          category: 'analysis',
          input_blob_id: 'blob-1',
          result_blob_id: 'blob-2',
          price: '600',
          payment_scheme: 1,
          max_price: '1000',
          metered_units: 2,
          unit_price: '300',
          verification_hash: Array.from(Buffer.from('aa'.repeat(32), 'hex')),
          status: 2,
          dispute_window_ms: 60_000,
          created_at: 1_000,
          accepted_at: 1_100,
          completed_at: 1_200,
          expires_at: 2_000,
          agreement_hash: 'hash-1',
        }),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(client.getTask('0xmetered')).resolves.toEqual({
      id: '0xmetered',
      requester: '0xrequester',
      provider: '0xprovider',
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'blob-1',
      resultBlobId: 'blob-2',
      price: 600n,
      paymentScheme: PaymentScheme.UPTO,
      maxPrice: 1000n,
      meteredUnits: 2,
      unitPrice: 300n,
      verificationHash: 'aa'.repeat(32),
      status: TaskStatus.COMPLETED,
      disputeWindowMs: 60_000,
      createdAt: 1_000,
      acceptedAt: 1_100,
      completedAt: 1_200,
      expiresAt: 2_000,
      agreementHash: 'hash-1',
    });
  });

  it('treats typed object-not-found errors as missing tasks', async () => {
    const client = new TaskClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockRejectedValue({ code: 'objectNotFound' }),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(client.getTask('0xmissing')).resolves.toBeNull();
  });

  it('treats nested JSON-RPC object-not-found codes as missing tasks', async () => {
    const client = new TaskClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockRejectedValue({ data: { code: -32000 } }),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(client.getTask('0xmissing')).resolves.toBeNull();
  });

  it('rejects invalid task ids before submitting task mutations', async () => {
    const executeTransaction = vi.fn();
    const client = new TaskClient(
      {
        executeTransaction,
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(
      client.acceptTask({
        taskId: 'not-an-object-id',
        keypair: {} as unknown as Ed25519Keypair,
      }),
    ).rejects.toThrow('taskId must be a 0x-prefixed hex object id.');
    expect(executeTransaction).not.toHaveBeenCalled();
  });
});
