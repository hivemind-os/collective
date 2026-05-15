import { describe, expect, it, vi } from 'vitest';

import { DisputeStatus } from '@agentic-mesh/types';

import { handleDispute } from '../src/commands/dispute.js';

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

describe('mesh dispute', () => {
  it('opens disputes and stores evidence', async () => {
    const client = {
      openDispute: vi.fn().mockResolvedValue({ disputeId: '0xdispute', txDigest: '0xtx' }),
      respondToDispute: vi.fn(),
      acceptResolution: vi.fn(),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn(),
    };
    const blobStore = {
      store: vi.fn().mockResolvedValue({ blobId: 'walrus:evidence' }),
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleDispute('open', ['0x3', '--split-mist', '500', '--evidence', '{"reason":"bad output"}'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(1) }),
      createClient: () => client as never,
      createBlobStore: () => blobStore,
    })).resolves.toBe(0);

    expect(blobStore.store).toHaveBeenCalledOnce();
    expect(client.openDispute).toHaveBeenCalledWith(expect.objectContaining({
      taskId: '0x3',
      evidenceBlobId: 'walrus:evidence',
      proposedSplitMist: 500n,
    }));
    expect(consoleLog).toHaveBeenCalled();
  });

  it('responds to disputes with a pre-uploaded evidence blob', async () => {
    const client = {
      openDispute: vi.fn(),
      respondToDispute: vi.fn().mockResolvedValue({ txDigest: '0xrespond' }),
      acceptResolution: vi.fn(),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleDispute('respond', ['0x4', '--split-mist', '250', '--evidence-blob-id', 'walrus:reply'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(2) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.respondToDispute).toHaveBeenCalledWith(expect.objectContaining({
      disputeId: '0x4',
      evidenceBlobId: 'walrus:reply',
      proposedSplitMist: 250n,
    }));
  });

  it('accepts dispute resolutions', async () => {
    const client = {
      openDispute: vi.fn(),
      respondToDispute: vi.fn(),
      acceptResolution: vi.fn().mockResolvedValue({ requesterAmount: 250n, providerAmount: 750n, txDigest: '0xaccept' }),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleDispute('accept', ['0x4', '0x3'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(3) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.acceptResolution).toHaveBeenCalledWith(expect.objectContaining({ disputeId: '0x4', taskId: '0x3' }));
  });

  it('rejects missing task ids and conflicting evidence sources', async () => {
    const client = {
      openDispute: vi.fn(),
      respondToDispute: vi.fn(),
      acceptResolution: vi.fn(),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn(),
    };

    await expect(handleDispute('status', ['--task'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(4) }),
      createClient: () => client as never,
    })).rejects.toThrow('Missing value for --task.');

    await expect(handleDispute('open', ['0x3', '--split-mist', '500', '--evidence', 'inline', '--evidence-file', 'evidence.txt'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(5) }),
      createClient: () => client as never,
    })).rejects.toThrow('Specify exactly one of --evidence, --evidence-file, or --evidence-blob-id.');
  });

  it('shows dispute status by task id', async () => {
    const client = {
      openDispute: vi.fn(),
      respondToDispute: vi.fn(),
      acceptResolution: vi.fn(),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn().mockResolvedValue({
        id: '0xdispute',
        taskId: '0x3',
        requester: '0xrequester',
        provider: '0xprovider',
        escrowAmount: 1_000n,
        status: DisputeStatus.OPEN,
        requesterEvidenceBlob: 'walrus:req',
        providerEvidenceBlob: undefined,
        requesterProposedSplit: 500n,
        providerProposedSplit: 0n,
        arbitrator: undefined,
        rulingSplit: 0n,
        openedAt: 100,
        respondedAt: undefined,
        resolvedAt: undefined,
        resolutionDeadline: 200,
      }),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleDispute('status', ['--task', '0x3'], {
      loadConfig: () => baseConfig as never,
      loadKeypair: () => ({ secretKey: new Uint8Array(32).fill(4) }),
      createClient: () => client as never,
    })).resolves.toBe(0);

    expect(client.getDisputeByTask).toHaveBeenCalledWith('0x3');
  });
});
