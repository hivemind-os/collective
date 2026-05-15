import { describe, expect, it, vi } from 'vitest';

import { DisputeStatus } from '@agentic-mesh/types';

import type { MeshToolContext } from '../src/context.js';
import { runMeshDispute } from '../src/tools/dispute.js';

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
    blobStore: {
      store: vi.fn(async () => ({ blobId: 'walrus:evidence' })),
      fetch: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
    } as unknown as MeshToolContext['blobStore'],
    spendingPolicy: {} as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    disputeClient: {
      openDispute: vi.fn(),
      respondToDispute: vi.fn(),
      acceptResolution: vi.fn(),
      getDispute: vi.fn(),
      getDisputeByTask: vi.fn(),
    } as unknown as MeshToolContext['disputeClient'],
    ...overrides,
  };
}

describe('runMeshDispute', () => {
  it('opens disputes and stores evidence first', async () => {
    const context = createContext();
    vi.mocked(context.disputeClient?.openDispute as never).mockResolvedValue({ disputeId: '0xdispute', txDigest: '0xtx' });

    const result = await runMeshDispute({
      action: 'open',
      task_id: '0x3',
      evidence: '{"reason":"bad output"}',
      proposed_split_mist: '500',
    }, context);

    expect(context.blobStore.store).toHaveBeenCalledOnce();
    expect(context.disputeClient?.openDispute).toHaveBeenCalledWith({
      taskId: '0x3',
      evidenceBlobId: 'walrus:evidence',
      proposedSplitMist: 500n,
      arbitratorAddress: undefined,
      signer: context.keypair,
    });
    expect(result).toMatchObject({ action: 'open', dispute_id: '0xdispute', tx_digest: '0xtx' });
  });

  it('responds and accepts disputes', async () => {
    const context = createContext();
    vi.mocked(context.disputeClient?.respondToDispute as never).mockResolvedValue({ txDigest: '0xrespond' });
    vi.mocked(context.disputeClient?.acceptResolution as never).mockResolvedValue({
      requesterAmount: 250n,
      providerAmount: 750n,
      txDigest: '0xaccept',
    });

    await expect(runMeshDispute({
      action: 'respond',
      dispute_id: '0x4',
      evidence_blob_id: 'walrus:reply',
      proposed_split_mist: '250',
    }, context)).resolves.toMatchObject({ action: 'respond', tx_digest: '0xrespond' });

    await expect(runMeshDispute({
      action: 'accept',
      dispute_id: '0x4',
      task_id: '0x3',
    }, context)).resolves.toMatchObject({
      action: 'accept',
      requester_amount_mist: '250',
      provider_amount_mist: '750',
      tx_digest: '0xaccept',
    });
  });

  it('rejects ambiguous status requests and conflicting evidence sources', async () => {
    const context = createContext();

    await expect(runMeshDispute({ action: 'status' }, context)).rejects.toThrow(
      'Provide exactly one of dispute_id or task_id when action=status',
    );

    await expect(runMeshDispute({
      action: 'open',
      task_id: '0x3',
      evidence: 'inline',
      evidence_blob_id: 'walrus:evidence',
      proposed_split_mist: '500',
    }, context)).rejects.toThrow('Provide exactly one of evidence or evidence_blob_id for dispute open/respond actions');
  });

  it('returns dispute status by task id', async () => {
    const context = createContext();
    vi.mocked(context.disputeClient?.getDisputeByTask as never).mockResolvedValue({
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
    });

    const result = await runMeshDispute({ action: 'status', task_id: '0x3' }, context);

    expect(context.disputeClient?.getDisputeByTask).toHaveBeenCalledWith('0x3');
    expect(result).toMatchObject({ action: 'status', dispute: { id: '0xdispute', taskId: '0x3' } });
  });
});
