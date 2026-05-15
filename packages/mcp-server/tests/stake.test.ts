import { describe, expect, it, vi } from 'vitest';

import type { MeshToolContext } from '../src/context.js';
import { runMeshStake } from '../src/tools/stake.js';

function createContext(overrides: Partial<MeshToolContext> = {}): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {
      getPublicKey: () => ({
        toSuiAddress: () => '0xabc',
      }),
    } as MeshToolContext['keypair'],
    suiClient: {
      getBalance: vi.fn(),
      queryEvents: vi.fn(),
    } as unknown as MeshToolContext['suiClient'],
    registryClient: {} as MeshToolContext['registryClient'],
    taskClient: {} as MeshToolContext['taskClient'],
    agentCache: {} as MeshToolContext['agentCache'],
    blobStore: {} as MeshToolContext['blobStore'],
    spendingPolicy: {} as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    stakingClient: {
      depositStake: vi.fn(),
      getStakeByOwner: vi.fn(),
      startDeactivation: vi.fn(),
      withdrawStake: vi.fn(),
    } as unknown as MeshToolContext['stakingClient'],
    ...overrides,
  };
}

describe('runMeshStake', () => {
  it('deposits stake through the staking client', async () => {
    const context = createContext();
    vi.mocked(context.stakingClient?.depositStake as never).mockResolvedValue({ stakeId: '0xstake', txDigest: '0xtx' });

    const result = await runMeshStake({ action: 'deposit', amount_sui: '10', stake_type: 'agent' }, context);

    expect(context.stakingClient?.depositStake).toHaveBeenCalledWith({
      amountMist: 10_000_000_000n,
      stakeType: 'agent',
      signer: context.keypair,
    });
    expect(result).toMatchObject({ action: 'deposit', stake_id: '0xstake', tx_digest: '0xtx' });
  });

  it('returns the current stake status', async () => {
    const context = createContext();
    vi.mocked(context.stakingClient?.getStakeByOwner as never).mockResolvedValue({
      id: '0xstake',
      owner: '0xabc',
      stakeType: 'agent',
      balanceMist: 10_000_000_000n,
      stakedAt: 1,
      deactivatedAt: 0,
      slashedAmount: 0n,
      isActive: true,
      meetsMinium: true,
    });

    const result = await runMeshStake({ action: 'status' }, context);

    expect(result).toMatchObject({ action: 'status', staked: true });
  });

  it('starts deactivation before withdrawing', async () => {
    const context = createContext();
    vi.mocked(context.stakingClient?.getStakeByOwner as never).mockResolvedValue({
      id: '0xstake',
      owner: '0xabc',
      stakeType: 'agent',
      balanceMist: 10_000_000_000n,
      stakedAt: 1,
      deactivatedAt: 0,
      slashedAmount: 0n,
    });
    vi.mocked(context.stakingClient?.startDeactivation as never).mockResolvedValue({ cooldownEndsAt: 1234, txDigest: '0xtx' });

    const result = await runMeshStake({ action: 'withdraw' }, context);

    expect(result).toMatchObject({ action: 'deactivation_started', cooldown_ends_at: 1234 });
  });
});
