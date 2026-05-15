import { describe, expect, it, vi } from 'vitest';

import { handleMetering } from '../src/commands/metering.js';

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
  auth: {
    mode: 'ed25519',
    portal: { port: 19876 },
  },
  spending: {
    defaultRail: 'sui-escrow',
    limits: [],
  },
  payment: {
    preferredRail: 'auto',
    evm: { enabled: false, network: 'base' },
  },
  daemon: {
    ipcPath: 'ipc',
    dataDir: 'data',
    pidFile: 'pid',
    logLevel: 'info',
  },
  relay: {
    enabled: false,
    endpoints: [],
    autoConnect: true,
    providerMode: false,
  },
  blobstore: {
    mode: 'filesystem',
    filesystem: { dataDir: 'blobs' },
  },
  encryption: {
    enabled: false,
    requireEncryption: false,
  },
};

function createState() {
  return {
    did: 'did:mesh:test',
    keypair: {} as never,
    suiClient: {} as never,
    registryClient: {} as never,
    taskClient: {} as never,
    agentCache: {} as never,
    blobStore: {} as never,
    spendingPolicy: {} as never,
    network: baseConfig.network,
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('mesh metering', () => {
  it('executes a metered task and prints the verified result', async () => {
    const state = createState();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleMetering('execute', [
      '--capability', 'echo',
      '--input', 'hello',
      '--max-price-mist', '10',
      '--unit-price-mist', '2',
    ], {
      loadConfig: () => baseConfig as never,
      createState: async () => state,
      runMeteredExecute: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        provider_did: 'did:mesh:provider',
        result: 'hello',
        status: 'RELEASED',
        payment_rail: 'sui-escrow',
        payment_scheme: 'upto',
        max_price_mist: '10',
        actual_price_mist: '6',
        unit_price_mist: '2',
        metered_units: 3,
        verification_hash: 'aa'.repeat(32),
        verified: true,
      }),
    })).resolves.toBe(0);

    expect(logSpy).toHaveBeenCalled();
    expect(state.shutdown).toHaveBeenCalledOnce();
  });

  it('verifies a metered task result', async () => {
    const state = createState();

    await expect(handleMetering('verify', ['task-1'], {
      loadConfig: () => baseConfig as never,
      createState: async () => state,
      runVerify: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        verified: true,
        verification_hash: 'aa'.repeat(32),
        metered_units: 3,
        result: 'hello',
      }),
    })).resolves.toBe(0);

    expect(state.shutdown).toHaveBeenCalledOnce();
  });
});
