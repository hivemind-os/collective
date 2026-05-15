import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { TaskClient, TaskStatus, type MeshSuiClient } from '../src/index.js';

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

  it('parses task objects', async () => {
    const client = new TaskClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          id: '0xtask',
          requester: '0xrequester',
          provider: '0x0',
          capability: 'summarize',
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
      inputBlobId: 'blob-1',
      resultBlobId: undefined,
      price: 500n,
      status: TaskStatus.OPEN,
      disputeWindowMs: 60_000,
      createdAt: 1_000,
      acceptedAt: undefined,
      completedAt: undefined,
      expiresAt: 2_000,
      agreementHash: 'hash-1',
    });
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
