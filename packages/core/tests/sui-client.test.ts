import type { SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it, vi } from 'vitest';

import { MeshSuiClient, SuiTransactionExecutionError } from '../src/index.js';

const networkConfig = {
  rpcUrl: 'http://127.0.0.1:9000',
  faucetUrl: 'http://127.0.0.1:9123',
  packageId: '0x1',
  registryId: '0x2',
};

function createKeypairStub(): Ed25519Keypair {
  return {
    getPublicKey: () => ({
      toSuiAddress: () => '0x123',
    }),
  } as unknown as Ed25519Keypair;
}

describe('MeshSuiClient', () => {
  it('throws informative errors for failed transaction effects', async () => {
    const client = new MeshSuiClient(networkConfig);
    const signAndExecuteTransaction = vi.fn().mockResolvedValue({ digest: '0xabc' });
    const waitForTransaction = vi.fn().mockResolvedValue({
      digest: '0xabc',
      effects: {
        status: {
          status: 'failure',
          error: 'Insufficient gas',
        },
      },
    } satisfies Partial<SuiTransactionBlockResponse>);

    Reflect.set(client, 'suiClient', {
      signAndExecuteTransaction,
      waitForTransaction,
    });

    const execution = client.executeTransaction(new Transaction(), createKeypairStub());

    await expect(execution).rejects.toThrow(SuiTransactionExecutionError);
    await expect(execution).rejects.toThrow(/insufficient gas/i);
  });

  it('retries retryable execution failures before succeeding', async () => {
    const client = new MeshSuiClient(networkConfig);
    const signAndExecuteTransaction = vi
      .fn()
      .mockResolvedValueOnce({ digest: '0xretry-1' })
      .mockResolvedValueOnce({ digest: '0xretry-2' });
    const waitForTransaction = vi
      .fn()
      .mockResolvedValueOnce({
        digest: '0xretry-1',
        effects: {
          status: {
            status: 'failure',
            error: 'Object lock conflict',
          },
        },
      } satisfies Partial<SuiTransactionBlockResponse>)
      .mockResolvedValueOnce({
        digest: '0xretry-2',
        effects: {
          status: {
            status: 'success',
          },
        },
      } satisfies Partial<SuiTransactionBlockResponse>);

    Reflect.set(client, 'suiClient', {
      signAndExecuteTransaction,
      waitForTransaction,
    });

    const response = await client.executeTransaction(new Transaction(), createKeypairStub());

    expect(response.digest).toBe('0xretry-2');
    expect(signAndExecuteTransaction).toHaveBeenCalledTimes(2);
    expect(waitForTransaction).toHaveBeenCalledTimes(2);
  });
});
