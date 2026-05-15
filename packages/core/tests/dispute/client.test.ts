import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { DisputeClient, DisputeStatus, type MeshSuiClient } from '../../src/index.js';

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

describe('DisputeClient', () => {
  it('opens disputes and returns the created dispute id', async () => {
    const executeTransaction = vi.fn().mockResolvedValue({
      digest: '0xtx',
      objectChanges: [
        {
          type: 'created',
          objectType: '0x1::dispute::Dispute',
          objectId: '0xdispute',
        },
      ],
      events: [],
    });
    const client = new DisputeClient(
      {
        executeTransaction,
        getObject: vi.fn(),
        queryEvents: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const result = await client.openDispute({
      taskId: '0x3',
      evidenceBlobId: 'walrus:evidence',
      proposedSplitMist: 500n,
      arbitratorAddress: '0x2',
      signer: {} as Ed25519Keypair,
    });

    const tx = executeTransaction.mock.calls[0]?.[0];
    expect(getMoveTargets(tx).some((target) => target.endsWith('::dispute::open_dispute'))).toBe(true);
    expect(result).toEqual({ disputeId: '0xdispute', txDigest: '0xtx' });
  });

  it('supports respond, accept, and arbitrate flows', async () => {
    const executeTransaction = vi
      .fn()
      .mockResolvedValueOnce({ digest: '0xrespond', events: [], objectChanges: [] })
      .mockResolvedValueOnce({
        digest: '0xaccept',
        events: [
          {
            type: '0x1::dispute::DisputeMutuallyResolved',
            parsedJson: { requester_amount: '250', provider_amount: '750' },
          },
        ],
        objectChanges: [],
      })
      .mockResolvedValueOnce({ digest: '0xarb', events: [], objectChanges: [] });
    const client = new DisputeClient(
      {
        executeTransaction,
        getObject: vi.fn(),
        queryEvents: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.respondToDispute({
      disputeId: '0x4',
      evidenceBlobId: 'walrus:reply',
      proposedSplitMist: 250n,
      signer: {} as Ed25519Keypair,
    })).resolves.toEqual({ txDigest: '0xrespond' });

    await expect(client.acceptResolution({
      disputeId: '0x4',
      taskId: '0x3',
      signer: {} as Ed25519Keypair,
    })).resolves.toEqual({ requesterAmount: 250n, providerAmount: 750n, txDigest: '0xaccept' });

    await expect(client.arbitrate({
      disputeId: '0x4',
      taskId: '0x3',
      rulingSplitMist: 400n,
      signer: {} as Ed25519Keypair,
    })).resolves.toEqual({ txDigest: '0xarb' });
  });

  it('parses dispute objects', async () => {
    const client = new DisputeClient(
      {
        executeTransaction: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          objectId: '0xdispute',
          task_id: '0xtask',
          requester: '0xrequester',
          provider: '0xprovider',
          escrow_amount: '1000',
          status: 1,
          requester_evidence_blob: 'walrus:req',
          provider_evidence_blob: 'walrus:prov',
          requester_proposed_split: '600',
          provider_proposed_split: '400',
          arbitrator: '0x0',
          ruling_split: '0',
          opened_at: 100,
          responded_at: 200,
          resolved_at: 0,
          resolution_deadline: 300,
        }),
        queryEvents: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const dispute = await client.getDispute('0xdispute');

    expect(dispute).toEqual({
      id: '0xdispute',
      taskId: '0xtask',
      requester: '0xrequester',
      provider: '0xprovider',
      escrowAmount: 1000n,
      status: DisputeStatus.RESPONDED,
      requesterEvidenceBlob: 'walrus:req',
      providerEvidenceBlob: 'walrus:prov',
      requesterProposedSplit: 600n,
      providerProposedSplit: 400n,
      arbitrator: undefined,
      rulingSplit: 0n,
      openedAt: 100,
      respondedAt: 200,
      resolvedAt: undefined,
      resolutionDeadline: 300,
    });
  });

  it('finds disputes by task id', async () => {
    const getObject = vi.fn().mockResolvedValue({
      objectId: '0xdispute',
      task_id: '0xtask',
      requester: '0xrequester',
      provider: '0xprovider',
      escrow_amount: '1000',
      status: 0,
      requester_evidence_blob: 'walrus:req',
      provider_evidence_blob: '',
      requester_proposed_split: '500',
      provider_proposed_split: '0',
      arbitrator: '0x3',
      ruling_split: '0',
      opened_at: 100,
      responded_at: 0,
      resolved_at: 0,
      resolution_deadline: 300,
    });
    const client = new DisputeClient(
      {
        executeTransaction: vi.fn(),
        getObject,
        queryEvents: vi.fn().mockResolvedValue({
          events: [
            {
              type: '0x1::dispute::DisputeOpened',
              parsedJson: { dispute_id: '0xdispute', task_id: '0xtask' },
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    const dispute = await client.getDisputeByTask('0xtask');

    expect(getObject).toHaveBeenCalledWith('0xdispute');
    expect(dispute?.id).toBe('0xdispute');
    expect(dispute?.arbitrator).toBe('0x3');
  });

  it('fails when the mutual resolution event is missing payout fields', async () => {
    const client = new DisputeClient(
      {
        executeTransaction: vi.fn().mockResolvedValue({
          digest: '0xaccept',
          events: [{ type: '0x1::dispute::DisputeMutuallyResolved', parsedJson: {} }],
          objectChanges: [],
        }),
        getObject: vi.fn(),
        queryEvents: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.acceptResolution({
      disputeId: '0x4',
      taskId: '0x3',
      signer: {} as Ed25519Keypair,
    })).rejects.toThrow('DisputeMutuallyResolved event did not include requester_amount.');
  });

  it('rejects invalid dispute ids before submitting dispute mutations', async () => {
    const executeTransaction = vi.fn();
    const client = new DisputeClient(
      {
        executeTransaction,
        getObject: vi.fn(),
        queryEvents: vi.fn(),
      } as unknown as MeshSuiClient,
      contractConfig,
    );

    await expect(client.respondToDispute({
      disputeId: 'not-an-object-id',
      evidenceBlobId: 'walrus:reply',
      proposedSplitMist: 1n,
      signer: {} as Ed25519Keypair,
    })).rejects.toThrow('disputeId must be a 0x-prefixed hex object id.');
    expect(executeTransaction).not.toHaveBeenCalled();
  });
});
