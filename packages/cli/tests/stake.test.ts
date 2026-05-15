import { describe, expect, it, vi } from 'vitest';

import { handleStake } from '../src/commands/stake.js';

const baseConfig = {
  network: {
    rpcUrl: 'http://127.0.0.1:9000',
    faucetUrl: 'http://127.0.0.1:9123',
    packageId: '0x1',
    registryId: '0x2',
  },
  identity: {
    dataDir: '.\\identity',
  },
  spending: {
    defaultRail: 'sui-escrow',
    limits: [],
  },
  daemon: {
    ipcPath: 'ipc',
    dataDir: 'data',
    pidFile: 'pid',
    logLevel: 'info',
  },
  blobstore: {
    type: 'filesystem',
    baseDir: 'blobs',
  },
};

describe('mesh stake', () => {
  it('deposits stake', async () => {
    const client = {
      depositStake: vi.fn().mockResolvedValue({ stakeId: '0xstake', txDigest: '0xtx' }),
      getStakeByOwner: vi.fn(),
      startDeactivation: vi.fn(),
      withdrawStake: vi.fn(),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleStake('deposit', ['10'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(1) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.depositStake).toHaveBeenCalledWith(expect.objectContaining({ amountMist: 10_000_000_000n }));
    expect(consoleLog).toHaveBeenCalled();
  });

  it('shows stake status', async () => {
    const client = {
      depositStake: vi.fn(),
      getStakeByOwner: vi.fn().mockResolvedValue({
        id: '0xstake',
        owner: '0xowner',
        stakeType: 'agent',
        balanceMist: 10_000_000_000n,
        stakedAt: 1,
        deactivatedAt: 0,
        slashedAmount: 0n,
        isActive: true,
        meetsMinium: true,
      }),
      startDeactivation: vi.fn(),
      withdrawStake: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(handleStake('status', [], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(2) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.getStakeByOwner).toHaveBeenCalled();
  });
});
