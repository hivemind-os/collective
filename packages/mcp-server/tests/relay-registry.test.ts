import { describe, expect, it, vi } from 'vitest';

import type { MeshToolContext } from '../src/context.js';
import { runMeshRelayRegistry } from '../src/tools/relay-registry.js';

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
    relayRegistryClient: {
      listRelays: vi.fn(),
      registerRelay: vi.fn(),
    } as unknown as MeshToolContext['relayRegistryClient'],
    ...overrides,
  };
}

describe('runMeshRelayRegistry', () => {
  it('lists relays via the relay registry client', async () => {
    const context = createContext();
    vi.mocked(context.relayRegistryClient?.listRelays as never).mockResolvedValue([{ id: '0xrelay' }]);

    const result = await runMeshRelayRegistry({ action: 'list' }, context);

    expect(context.relayRegistryClient?.listRelays).toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'list', count: 1 });
  });

  it('registers a relay via the relay registry client', async () => {
    const context = createContext();
    vi.mocked(context.relayRegistryClient?.registerRelay as never).mockResolvedValue({ relayId: '0xrelay', txDigest: '0xtx' });

    const result = await runMeshRelayRegistry({
      action: 'register',
      endpoint: 'wss://relay.mesh.example/ws',
      stake_id: '0x123',
      region: 'us-east',
      routing_fee_bps: 50,
      capabilities: ['routing', 'streaming'],
    }, context);

    expect(context.relayRegistryClient?.registerRelay).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'wss://relay.mesh.example/ws',
      stakeId: '0x123',
      region: 'us-east',
      routingFeeBps: 50,
      capabilities: ['routing', 'streaming'],
      signer: context.keypair,
    }));
    expect(result).toMatchObject({ action: 'register', relay_id: '0xrelay', tx_digest: '0xtx' });
  });
});
