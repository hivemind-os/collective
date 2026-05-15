import { describe, expect, it, vi } from 'vitest';

import { handleMarketplace } from '../src/commands/marketplace.js';

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

describe('mesh marketplace', () => {
  it('posts marketplace tasks', async () => {
    const client = {
      postOpenTask: vi.fn().mockResolvedValue({ taskId: '0xtask', txDigest: '0xtx' }),
      browseOpenTasks: vi.fn(),
      placeBid: vi.fn(),
      acceptBid: vi.fn(),
    };
    const blobStore = {
      store: vi.fn().mockResolvedValue({ blobId: 'walrus:input' }),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleMarketplace('post', ['summarize', '--category', 'analysis', '--price-mist', '500', '--input', 'hello'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(1) }),
      createClient: () => client as never,
      createBlobStore: () => blobStore,
    })).resolves.toBe(0);

    expect(blobStore.store).toHaveBeenCalledOnce();
    expect(client.postOpenTask).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'summarize',
      category: 'analysis',
      inputBlobId: 'walrus:input',
      priceMist: 500n,
    }));
    expect(consoleLog).toHaveBeenCalled();
  });

  it('browses marketplace tasks', async () => {
    const client = {
      postOpenTask: vi.fn(),
      browseOpenTasks: vi.fn().mockResolvedValue([{ id: '0xtask', category: 'analysis', capability: 'summarize', price: 500n, requester: '0xabc' }]),
      placeBid: vi.fn(),
      acceptBid: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleMarketplace('browse', ['--category', 'analysis', '--limit', '5'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(2) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.browseOpenTasks).toHaveBeenCalledWith({
      category: 'analysis',
      minPriceMist: undefined,
      maxPriceMist: undefined,
      limit: 5,
    });
  });

  it('rejects conflicting input sources and missing flag values', async () => {
    const client = {
      postOpenTask: vi.fn(),
      browseOpenTasks: vi.fn(),
      placeBid: vi.fn(),
      acceptBid: vi.fn(),
    };

    await expect(handleMarketplace('post', ['summarize', '--category', 'analysis', '--price-mist', '500', '--input', 'hello', '--input-file', 'task.txt'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(3) }),
      createClient: () => client as never,
    })).rejects.toThrow('Specify exactly one of --input, --input-file, or --input-blob-id.');

    await expect(handleMarketplace('post', ['summarize', '--category', '--price-mist', '500', '--input', 'hello'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(4) }),
      createClient: () => client as never,
    })).rejects.toThrow('Missing value for --category.');
  });

  it('places and accepts bids', async () => {
    const client = {
      postOpenTask: vi.fn(),
      browseOpenTasks: vi.fn(),
      placeBid: vi.fn().mockResolvedValue({ bidId: '0xbid', txDigest: '0xbidtx', reputationScore: 77n }),
      acceptBid: vi.fn().mockResolvedValue({ txDigest: '0xaccept', rejectedBidIds: ['0xbid-2'] }),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleMarketplace('bid', ['0xtask', '--price-mist', '400', '--reputation-score', '77'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(3) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.placeBid).toHaveBeenCalledWith(expect.objectContaining({ taskId: '0xtask', bidPriceMist: 400n, reputationScore: 77n }));

    await expect(handleMarketplace('accept-bid', ['0xtask', '0xbid'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(4) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.acceptBid).toHaveBeenCalledWith(expect.objectContaining({ taskId: '0xtask', bidId: '0xbid', rejectCompeting: true }));
  });
});
