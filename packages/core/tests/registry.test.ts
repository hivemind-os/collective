import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, RegistryClient, type MeshSuiClient } from '../src/index.js';

const networkConfig = {
  rpcUrl: 'http://127.0.0.1:9000',
  faucetUrl: 'http://127.0.0.1:9123',
  packageId: '0x1',
  registryId: '0x2',
};

function getMoveTargets(tx: { getData: () => { commands: Array<Record<string, unknown>> } }): string[] {
  return tx
    .getData()
    .commands.map((command) => {
      if ('MoveCall' in command && typeof command.MoveCall === 'object' && command.MoveCall) {
        const moveCall = command.MoveCall as {
          package: string;
          module: string;
          function: string;
        };
        return `${moveCall.package}::${moveCall.module}::${moveCall.function}`;
      }

      return '';
    })
    .filter(Boolean);
}

describe('RegistryClient', () => {
  it('builds a register agent transaction', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({
      digest: '0xtx',
      objectChanges: [
        {
          type: 'created',
          objectType: '0x1::registry::AgentCard',
          objectId: '0x3',
        },
      ],
    });
    const client = new RegistryClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const result = await client.registerAgent({
      name: 'Agent One',
      did: 'did:mesh:agent-1',
      description: 'Helpful',
      capabilities: [
        {
          name: 'summarize',
          description: 'Summarize text',
          version: '1.0.0',
          pricing: {
            rail: PaymentRail.SUI_ESCROW,
            amount: 100n,
            currency: 'MIST',
          },
        },
      ],
      endpoint: 'https://example.com',
      keypair: {} as unknown as Ed25519Keypair,
    });

    const tx = executeTransaction.mock.calls[0]?.[0];
    expect(getMoveTargets(tx).some((target) => target.endsWith('::registry::register_agent'))).toBe(true);
    expect(result).toEqual({ txDigest: '0xtx', agentCardId: '0x3' });
  });

  it('queries AgentRegistered events for capability discovery', async () => {
    const queryEvents = vi.fn().mockResolvedValue({ events: [], nextCursor: null, hasMore: false });
    const client = new RegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents,
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await client.discoverByCapability('summarize', 5);

    expect(queryEvents).toHaveBeenCalledWith('0x1::registry::AgentRegistered', null, 20);
  });

  it('rejects invalid DIDs before submitting a transaction', async () => {
    const executeTransaction = vi.fn();
    const client = new RegistryClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    await expect(
      client.registerAgent({
        name: 'Agent One',
        did: 'invalid-did',
        description: 'Helpful',
        capabilities: [],
        endpoint: 'https://example.com',
        keypair: {} as unknown as Ed25519Keypair,
      }),
    ).rejects.toThrow('did must be a did:mesh identifier.');
    expect(executeTransaction).not.toHaveBeenCalled();
  });
});
