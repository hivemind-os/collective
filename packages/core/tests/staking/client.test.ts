import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, RegistryClient, StakingClient, type MeshSuiClient, type AgentCard } from '../../src/index.js';

const contractConfig = { packageId: '0x1' };
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

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xowner-1',
    did: 'did:mesh:agent-1' as AgentCard['did'],
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
    endpoint: 'mesh://agent/did:mesh:agent-1',
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
    totalTasksCompleted: 1,
    totalTasksFailed: 0,
    ...overrides,
  };
}

describe('StakingClient', () => {
  it('builds a deposit stake transaction and returns the new stake id', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({
      digest: '0xtx',
      objectChanges: [],
      events: [
        {
          type: '0x1::staking::StakeDeposited',
          parsedJson: { stake_id: '0xstake-1' },
        },
      ],
    });
    const client = new StakingClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const result = await client.depositStake({
      amountMist: 10_000_000_000n,
      stakeType: 'agent',
      signer: {} as Ed25519Keypair,
    });

    const tx = executeTransaction.mock.calls[0]?.[0];
    expect(getMoveTargets(tx).some((target) => target.endsWith('::staking::deposit_stake'))).toBe(true);
    expect(result).toEqual({ stakeId: '0xstake-1', txDigest: '0xtx' });
  });

  it('parses stake positions from Move objects', async () => {
    const client = new StakingClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          objectId: '0xstake-1',
          owner: '0xowner-1',
          stake_type: 0,
          balance: { value: '10000000000' },
          staked_at: 123,
          deactivated_at: 0,
          slashed_amount: '50',
        }),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const position = await client.getStakePosition('0xstake-1');

    expect(position).toEqual({
      id: '0xstake-1',
      owner: '0xowner-1',
      stakeType: 'agent',
      balanceMist: 10_000_000_000n,
      stakedAt: 123,
      deactivatedAt: 0,
      slashedAmount: 50n,
      isActive: true,
      meetsMinium: true,
      meetsMinimum: true,
    });
  });

  it('returns the best active stake for an owner', async () => {
    const getObject = vi.fn().mockImplementation(async (id: string) => ({
      objectId: id,
      owner: '0xowner-1',
      stake_type: 0,
      balance: { value: id === '0xstake-active' ? '12000000000' : '5000000000' },
      staked_at: id === '0xstake-active' ? 2 : 1,
      deactivated_at: id === '0xstake-active' ? 0 : 3,
      slashed_amount: '0',
    }));
    const client = new StakingClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn().mockResolvedValue({
          events: [
            { type: '0x1::staking::StakeDeposited', parsedJson: { owner: '0xowner-1', stake_id: '0xstake-old' } },
            { type: '0x1::staking::StakeDeposited', parsedJson: { owner: '0xowner-1', stake_id: '0xstake-active' } },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        getObject,
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const position = await client.getStakeByOwner('0xowner-1');

    expect(position?.id).toBe('0xstake-active');
  });

  it('fails when the deactivation event omits cooldown metadata', async () => {
    const client = new StakingClient(
      {
        executeTransaction: vi.fn().mockResolvedValue({
          digest: '0xdeactivate',
          events: [{ type: '0x1::staking::DeactivationStarted', parsedJson: {} }],
          objectChanges: [],
        }),
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.startDeactivation({ stakeId: '0x123', signer: {} as Ed25519Keypair })).rejects.toThrow(
      'DeactivationStarted event did not include a valid cooldown_ends_at.',
    );
  });

  it('supports add stake, deactivation, withdrawal, and slashing flows', async () => {
    const executeTransaction = vi
      .fn()
      .mockResolvedValueOnce({ digest: '0xadd', events: [], objectChanges: [] })
      .mockResolvedValueOnce({
        digest: '0xdeactivate',
        events: [{ type: '0x1::staking::DeactivationStarted', parsedJson: { cooldown_ends_at: 1234 } }],
        objectChanges: [],
      })
      .mockResolvedValueOnce({
        digest: '0xwithdraw',
        events: [{ type: '0x1::staking::StakeWithdrawn', parsedJson: { amount: '5000' } }],
        objectChanges: [],
      })
      .mockResolvedValueOnce({
        digest: '0xslash',
        events: [{ type: '0x1::staking::StakeSlashed', parsedJson: { amount: '25' } }],
        objectChanges: [],
      });
    const client = new StakingClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.addStake({ stakeId: '0x123', amountMist: 100n, signer: {} as Ed25519Keypair })).resolves.toEqual({
      txDigest: '0xadd',
    });
    await expect(client.startDeactivation({ stakeId: '0x123', signer: {} as Ed25519Keypair })).resolves.toEqual({
      cooldownEndsAt: 1234,
      txDigest: '0xdeactivate',
    });
    await expect(client.withdrawStake({ stakeId: '0x123', signer: {} as Ed25519Keypair })).resolves.toEqual({
      amountReturned: 5000n,
      txDigest: '0xwithdraw',
    });
    await expect(client.slashExpiredEscrow({ stakeId: '0x123', taskId: '0x456', signer: {} as Ed25519Keypair })).resolves.toEqual({
      slashedAmount: 25n,
      txDigest: '0xslash',
    });
  });
});

describe('RegistryClient staking discovery', () => {
  it('ranks staked agents ahead of unstaked peers', async () => {
    const staked = createAgent({ owner: '0xowner-staked', totalTasksCompleted: 3 });
    const unstaked = createAgent({
      id: '0xagent-2',
      did: 'did:mesh:agent-2' as AgentCard['did'],
      owner: '0xowner-unstaked',
      totalTasksCompleted: 3,
    });
    const getStakeByOwner = vi.spyOn(StakingClient.prototype, 'getStakeByOwner')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: '0xstake',
        owner: staked.owner,
        stakeType: 'agent',
        balanceMist: 10_000_000_000n,
        stakedAt: 1,
        deactivatedAt: 0,
        slashedAmount: 0n,
        isActive: true,
        meetsMinium: true,
      });

    const client = new RegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn().mockResolvedValue({
          events: [
            {
              id: { txDigest: '0x1', eventSeq: '0' },
              type: '0x1::registry::AgentRegistered',
              timestampMs: '1',
              parsedJson: { card_id: unstaked.id, capabilities: unstaked.capabilities },
            },
            {
              id: { txDigest: '0x2', eventSeq: '1' },
              type: '0x1::registry::AgentRegistered',
              timestampMs: '2',
              parsedJson: { card_id: staked.id, capabilities: staked.capabilities },
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        getObject: vi.fn().mockImplementation(async (id: string) => {
          if (id === staked.id) {
            return staked;
          }
          if (id === unstaked.id) {
            return unstaked;
          }
          throw new Error(`unexpected object ${id}`);
        }),
      } as unknown as MeshSuiClient,
      networkConfig,
    );

    const results = await client.discoverByCapability('summarize', 10, { sortByReputation: true });

    expect(getStakeByOwner).toHaveBeenCalledTimes(2);
    expect(results.map((agent) => agent.did)).toEqual([staked.did, unstaked.did]);
    expect(results[0]?.hasStake).toBe(true);
  });
});
