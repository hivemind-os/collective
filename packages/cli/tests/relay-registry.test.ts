import { describe, expect, it, vi } from 'vitest';

import { RelayNodeStatus } from '@hivemind-os/collective-types';

import { handleRelayRegistry } from '../src/commands/relay-registry.js';

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
  indexer: {
    enabled: false,
  },
};

describe('mesh relay', () => {
  it('registers a relay', async () => {
    const client = {
      registerRelay: vi.fn().mockResolvedValue({ relayId: '0xrelay', txDigest: '0xtx' }),
      listRelays: vi.fn(),
      heartbeat: vi.fn(),
      deactivateRelay: vi.fn(),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleRelayRegistry('register', [
      '--endpoint', 'wss://relay.mesh.example/ws',
      '--stake-id', '0x123',
      '--region', 'us-east',
      '--fee', '50',
      '--capabilities', 'routing,streaming',
    ], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(1) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.registerRelay).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'wss://relay.mesh.example/ws',
      stakeId: '0x123',
      region: 'us-east',
      routingFeeBps: 50,
      capabilities: ['routing', 'streaming'],
    }));
    expect(consoleLog).toHaveBeenCalled();
  });

  it('lists active relays', async () => {
    const client = {
      registerRelay: vi.fn(),
      listRelays: vi.fn().mockResolvedValue([
        {
          id: '0xrelay',
          operator: '0xowner',
          endpoint: 'wss://relay.mesh.example/ws',
          stakePositionId: '0xstake',
          capabilities: ['routing'],
          region: 'us-east',
          status: RelayNodeStatus.ACTIVE,
          registeredAt: 1_000,
          lastHeartbeat: 2_000,
          routingFeeBps: 50,
          totalRouted: 2,
          totalFeesEarnedMist: 1_000_000_000n,
          stakeAmountMist: 100_000_000_000n,
        },
      ]),
      heartbeat: vi.fn(),
      deactivateRelay: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(handleRelayRegistry('list', [], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(2) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.listRelays).toHaveBeenCalled();
  });
});
