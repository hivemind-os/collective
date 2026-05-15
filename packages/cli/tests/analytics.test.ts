import { describe, expect, it, vi } from 'vitest';

import { handleAnalytics } from '../src/commands/analytics.js';

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
    enabled: true,
    url: 'http://localhost:4000/graphql',
  },
};

describe('mesh analytics', () => {
  it('renders analytics summary from the indexer', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      handleAnalytics('summary', [], {
        loadConfig: () => baseConfig as never,
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              analytics: {
                totalAgents: 1,
                activeAgents: 1,
                totalTasks: 2,
                completedTasks: 1,
                disputedTasks: 0,
                totalVolumeMist: '500',
                marketplace: { averageBidCount: 1.5, acceptanceRate: 0.5 },
              },
            },
          }),
        }) as never,
      }),
    ).resolves.toBe(0);

    expect(consoleLog).toHaveBeenCalled();
  });

  it('passes task volume arguments through to GraphQL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { taskVolume: [{ label: '2025-01-01', count: 2, volumeMist: '500' }] },
      }),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      handleAnalytics('task-volume', ['--period', 'DAY', '--buckets', '7'], {
        loadConfig: () => baseConfig as never,
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4000/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('taskVolume'),
      }),
    );
  });
});
