import { describe, expect, it, vi } from 'vitest';

import { handleMultiExecute } from '../src/commands/multi-execute.js';

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

describe('mesh multi-execute', () => {
  it('runs the multi execute flow and prints provider results', async () => {
    const state = createState();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleMultiExecute([
      '--capability', 'echo',
      '--input', '{"message":"hello"}',
      '--fan-out', '2',
      '--strategy', 'weighted',
    ], {
      loadConfig: () => baseConfig as never,
      createState: async () => state,
      runMultiExecute: vi.fn().mockResolvedValue({
        capability: 'echo',
        strategy: 'weighted',
        aggregation: 'first_success',
        providers: [
          { did: 'did:mesh:a', price_mist: '5', reputation: 90, estimated_latency_ms: 100, composite_score: 0.8 },
          { did: 'did:mesh:b', price_mist: '7', reputation: 80, estimated_latency_ms: 120, composite_score: 0.7 },
        ],
        results: [
          { provider: 'did:mesh:a', status: 'success', result: { ok: true }, duration_ms: 25 },
          { provider: 'did:mesh:b', status: 'timeout', duration_ms: 100, error: 'Provider request timed out.' },
        ],
        aggregated_result: { ok: true },
        total_cost_mist: '5',
      }),
    })).resolves.toBe(0);

    expect(logSpy).toHaveBeenCalled();
    expect(state.shutdown).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON input', async () => {
    await expect(handleMultiExecute([
      '--capability', 'echo',
      '--input', 'not-json',
    ], {
      loadConfig: () => baseConfig as never,
      createState: async () => createState(),
      runMultiExecute: vi.fn(),
    })).rejects.toThrow('Invalid --input JSON.');
  });
});
