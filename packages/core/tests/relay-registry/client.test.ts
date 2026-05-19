import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RelayDiscovery, RelayNodeStatus, RelayRegistryClient, StakingClient, type MeshSuiClient, type RelayNode } from '../../src/index.js';

interface RelayRegistryLoggerMock {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

const contractConfig = { packageId: '0x1' };

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

function createRelay(overrides: Partial<RelayNode> = {}): RelayNode {
  return {
    id: '0x111',
    operator: '0xaaa',
    endpoint: 'wss://relay-1.mesh.example/ws',
    stakePositionId: '0x123',
    capabilities: ['routing', 'streaming'],
    region: 'us-east',
    status: RelayNodeStatus.ACTIVE,
    registeredAt: 1_000,
    lastHeartbeat: 1_500,
    routingFeeBps: 50,
    totalRouted: 10,
    totalFeesEarnedMist: 999n,
    stakeAmountMist: 100_000_000_000n,
    heartbeatAgeMs: 500,
    isHeartbeatFresh: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('pino');
  vi.doUnmock('../../src/staking/client.js');
  vi.useRealTimers();
});

async function loadRelayRegistryClientModule(options?: {
  logger?: RelayRegistryLoggerMock;
  getStakePosition?: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  vi.doUnmock('pino');
  vi.doUnmock('../../src/staking/client.js');

  const logger = options?.logger ?? { debug: vi.fn(), warn: vi.fn() };
  vi.doMock('pino', () => ({
    default: vi.fn(() => logger),
  }));

  if (options?.getStakePosition) {
    vi.doMock('../../src/staking/client.js', () => ({
      StakingClient: class {
        getStakePosition = options.getStakePosition;
      },
    }));
  }

  const module = await import('../../src/relay-registry/client.js');
  return { ...module, logger };
}

describe('RelayRegistryClient', () => {
  it('builds relay registry transactions', async () => {
    const executeTransaction = vi
      .fn()
      .mockResolvedValueOnce({
        digest: '0xregister',
        objectChanges: [{ type: 'created', objectType: '0x1::relay_registry::RelayNode', objectId: '0x111' }],
        events: [{ type: '0x1::relay_registry::RelayRegistered', parsedJson: { relay_id: '0x111' } }],
      })
      .mockResolvedValueOnce({
        digest: '0xheartbeat',
        objectChanges: [],
        events: [{ type: '0x1::relay_registry::RelayHeartbeat', parsedJson: { last_heartbeat: 1234 } }],
      })
      .mockResolvedValueOnce({ digest: '0xdeactivate', objectChanges: [], events: [] });
    const client = new RelayRegistryClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(
      client.registerRelay({
        endpoint: 'wss://relay.mesh.example/ws',
        stakeId: '0x123',
        capabilities: ['routing'],
        region: 'us-east',
        routingFeeBps: 50,
        signer: {} as Ed25519Keypair,
      }),
    ).resolves.toEqual({ relayId: '0x111', txDigest: '0xregister' });
    await expect(client.heartbeat({ relayId: '0x111', signer: {} as Ed25519Keypair })).resolves.toEqual({
      lastHeartbeat: 1234,
      txDigest: '0xheartbeat',
    });
    await expect(client.deactivateRelay({ relayId: '0x111', signer: {} as Ed25519Keypair })).resolves.toEqual({
      txDigest: '0xdeactivate',
    });

    expect(getMoveTargets(executeTransaction.mock.calls[0]?.[0]).some((target) => target.endsWith('::relay_registry::register_relay'))).toBe(true);
    expect(getMoveTargets(executeTransaction.mock.calls[1]?.[0]).some((target) => target.endsWith('::relay_registry::heartbeat'))).toBe(true);
    expect(getMoveTargets(executeTransaction.mock.calls[2]?.[0]).some((target) => target.endsWith('::relay_registry::deactivate_relay'))).toBe(true);
  });

  it('rejects external routing metric reports', async () => {
    const executeTransaction = vi.fn();
    const client = new RelayRegistryClient(
      {
        executeTransaction,
        queryEvents: vi.fn(),
        getObject: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(
      client.recordRouting({ relayId: '0x111', feeAmountMist: 25n, signer: {} as Ed25519Keypair }),
    ).rejects.toThrow('Relay routing metrics are package-internal and cannot be reported by external operators.');
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('parses relay nodes and enriches stake metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    vi.spyOn(StakingClient.prototype, 'getStakePosition').mockResolvedValue({
      id: '0x123',
      owner: '0xaaa',
      stakeType: 'relay',
      balanceMist: 200_000_000_000n,
      stakedAt: 1,
      deactivatedAt: 0,
      slashedAmount: 0n,
      isActive: true,
      meetsMinium: true,
      meetsMinimum: true,
    });
    const client = new RelayRegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          objectId: '0x111',
          operator: '0xaaa',
          endpoint: 'wss://relay.mesh.example/ws',
          stake_position_id: '0x123',
          capabilities: ['routing', 'streaming'],
          region: 'us-east',
          status: 0,
          registered_at: 1_000,
          last_heartbeat: 1_500,
          routing_fee_bps: 50,
          total_routed: 7,
          total_fees_earned: '999',
        }),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.getRelay('0x111')).resolves.toEqual({
      id: '0x111',
      operator: '0xaaa',
      endpoint: 'wss://relay.mesh.example/ws',
      stakePositionId: '0x123',
      capabilities: ['routing', 'streaming'],
      region: 'us-east',
      status: RelayNodeStatus.ACTIVE,
      registeredAt: 1_000,
      lastHeartbeat: 1_500,
      routingFeeBps: 50,
      totalRouted: 7,
      totalFeesEarnedMist: 999n,
      stakeAmountMist: 200_000_000_000n,
      heartbeatAgeMs: 500,
      isHeartbeatFresh: true,
    });
  });

  it('lists relays with active filtering by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(StakingClient.prototype, 'getStakePosition').mockImplementation(async (stakeId: string) => ({
      id: stakeId,
      owner: '0xaaa',
      stakeType: 'relay',
      balanceMist: stakeId === '0x124' ? 150_000_000_000n : 100_000_000_000n,
      stakedAt: 1,
      deactivatedAt: 0,
      slashedAmount: 0n,
      isActive: true,
      meetsMinium: true,
      meetsMinimum: true,
    }));
    const client = new RelayRegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn().mockResolvedValue({
          events: [
            { type: '0x1::relay_registry::RelayRegistered', parsedJson: { relay_id: '0x111' } },
            { type: '0x1::relay_registry::RelayRegistered', parsedJson: { relay_id: '0x112' } },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        getObject: vi.fn().mockImplementation(async (relayId: string) => ({
          objectId: relayId,
          operator: relayId === '0x112' ? '0xaab' : '0xaaa',
          endpoint: `wss://${relayId}.mesh.example/ws`,
          stake_position_id: relayId === '0x112' ? '0x124' : '0x123',
          capabilities: relayId === '0x112' ? ['routing', 'streaming'] : ['routing'],
          region: relayId === '0x112' ? 'us-west' : 'us-east',
          status: relayId === '0x112' ? 1 : 0,
          registered_at: 1_000,
          last_heartbeat: relayId === '0x112' ? 9_000 : 9_500,
          routing_fee_bps: relayId === '0x112' ? 25 : 50,
          total_routed: 0,
          total_fees_earned: '0',
        })),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const activeRelays = await client.listRelays();
    const westRelays = await client.listRelays({ activeOnly: false, region: 'us-west' });

    expect(activeRelays.map((relay) => relay.id)).toEqual(['0x111']);
    expect(westRelays.map((relay) => relay.id)).toEqual(['0x112']);
    await expect(client.getRelaysByRegion('us-east')).resolves.toHaveLength(1);
  });

  it('logs missing stake lookups at debug level and unexpected stake errors at warn level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const missingStakeLogger = { debug: vi.fn(), warn: vi.fn() };
    const { RelayRegistryClient: MissingStakeRelayRegistryClient } = await loadRelayRegistryClientModule({
      logger: missingStakeLogger,
      getStakePosition: vi.fn().mockRejectedValue({ code: 'objectNotFound' }),
    });
    const missingStakeClient = new MissingStakeRelayRegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          objectId: '0x111',
          operator: '0xaaa',
          endpoint: 'wss://relay.mesh.example/ws',
          stake_position_id: '0x123',
          capabilities: ['routing'],
          region: 'us-east',
          status: 0,
          registered_at: 1_000,
          last_heartbeat: 1_500,
          routing_fee_bps: 50,
          total_routed: 7,
          total_fees_earned: '999',
        }),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const missingStakeRelay = await missingStakeClient.getRelay('0x111');
    expect(missingStakeRelay).toMatchObject({
      id: '0x111',
      heartbeatAgeMs: 500,
      isHeartbeatFresh: true,
    });
    expect(missingStakeRelay?.stakeAmountMist).toBeUndefined();
    expect(missingStakeLogger.debug).toHaveBeenCalledWith(
      { relayId: '0x111', stakePositionId: '0x123' },
      'Stake position not found.',
    );
    expect(missingStakeLogger.warn).not.toHaveBeenCalled();

    const unexpectedLogger = { debug: vi.fn(), warn: vi.fn() };
    const { RelayRegistryClient: UnexpectedRelayRegistryClient } = await loadRelayRegistryClientModule({
      logger: unexpectedLogger,
      getStakePosition: vi.fn().mockRejectedValue(new Error('rpc timeout')),
    });
    const unexpectedClient = new UnexpectedRelayRegistryClient(
      {
        executeTransaction: vi.fn(),
        queryEvents: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          objectId: '0x111',
          operator: '0xaaa',
          endpoint: 'wss://relay.mesh.example/ws',
          stake_position_id: '0x123',
          capabilities: ['routing'],
          region: 'us-east',
          status: 0,
          registered_at: 1_000,
          last_heartbeat: 1_500,
          routing_fee_bps: 50,
          total_routed: 7,
          total_fees_earned: '999',
        }),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const unexpectedRelay = await unexpectedClient.getRelay('0x111');
    expect(unexpectedRelay).toMatchObject({
      id: '0x111',
      heartbeatAgeMs: 500,
      isHeartbeatFresh: true,
    });
    expect(unexpectedRelay?.stakeAmountMist).toBeUndefined();
    expect(unexpectedLogger.debug).not.toHaveBeenCalled();
    expect(unexpectedLogger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), relayId: '0x111', stakePositionId: '0x123' },
      'Unexpected error enriching relay with stake data.',
    );
  });
});

describe('RelayDiscovery', () => {
  it('selects the best relay and caches relay lists', async () => {
    let now = 10_000;
    const listRelays = vi.fn().mockResolvedValue([
      createRelay({ id: '0xrelay-east', region: 'us-east', routingFeeBps: 50, stakeAmountMist: 150_000_000_000n, heartbeatAgeMs: 100 }),
      createRelay({
        id: '0xrelay-west',
        region: 'us-west',
        routingFeeBps: 10,
        stakeAmountMist: 80_000_000_000n,
        heartbeatAgeMs: 100,
      }),
      createRelay({
        id: '0xrelay-stale',
        region: 'us-east',
        routingFeeBps: 20,
        stakeAmountMist: 500_000_000_000n,
        heartbeatAgeMs: 40_000,
        isHeartbeatFresh: false,
      }),
    ]);
    const discovery = new RelayDiscovery({ listRelays } as Pick<RelayRegistryClient, 'listRelays'>, {
      cacheTtlMs: 1_000,
      heartbeatFreshnessMs: 5_000,
      now: () => now,
    });

    const first = await discovery.findBestRelay('routing', 'us-east');
    const second = await discovery.findBestRelay('routing', 'us-east');
    now = 12_000;
    const third = await discovery.findBestRelay('routing', 'us-east');

    expect(first?.id).toBe('0xrelay-east');
    expect(second?.id).toBe('0xrelay-east');
    expect(third?.id).toBe('0xrelay-east');
    expect(listRelays).toHaveBeenCalledTimes(2);
  });
});
