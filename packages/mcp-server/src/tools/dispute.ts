import { DisputeClient } from '@hivemind-os/collective-core';

import type { MeshToolContext } from '../context.js';

export interface MeshDisputeParams {
  action: 'open' | 'respond' | 'accept' | 'status';
  task_id?: string;
  dispute_id?: string;
  evidence?: string;
  evidence_blob_id?: string;
  proposed_split_mist?: string | number;
  arbitrator_address?: string;
}

export const meshDisputeTool = {
  name: 'collective_dispute',
  description: 'Open, respond to, accept, or inspect on-chain task disputes',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['open', 'respond', 'accept', 'status'] },
      task_id: { type: 'string', description: 'Task object id' },
      dispute_id: { type: 'string', description: 'Dispute object id' },
      evidence: { type: 'string', description: 'Plain text or JSON-encoded evidence to store before opening/responding' },
      evidence_blob_id: { type: 'string', description: 'Existing Walrus/blobstore blob id containing dispute evidence' },
      proposed_split_mist: { type: 'string', description: 'Amount, in MIST, to allocate back to the requester' },
      arbitrator_address: { type: 'string', description: 'Optional arbitrator address for open actions' },
    },
    required: ['action'],
  },
};

export async function runMeshDispute(params: MeshDisputeParams, context: MeshToolContext): Promise<Record<string, unknown>> {
  const client = context.disputeClient ?? new DisputeClient(context.suiClient, context.networkConfig);

  switch (params.action) {
    case 'open': {
      if (!params.task_id) {
        throw new Error('task_id is required when action=open');
      }
      const evidenceBlobId = await resolveEvidenceBlobId(params, context);
      const result = await client.openDispute({
        taskId: params.task_id,
        evidenceBlobId,
        proposedSplitMist: parseMist(params.proposed_split_mist, 'proposed_split_mist'),
        arbitratorAddress: params.arbitrator_address,
        signer: context.keypair as never,
      });
      return {
        action: 'open',
        dispute_id: result.disputeId,
        task_id: params.task_id,
        evidence_blob_id: evidenceBlobId,
        tx_digest: result.txDigest,
      };
    }
    case 'respond': {
      if (!params.dispute_id) {
        throw new Error('dispute_id is required when action=respond');
      }
      const evidenceBlobId = await resolveEvidenceBlobId(params, context);
      const result = await client.respondToDispute({
        disputeId: params.dispute_id,
        evidenceBlobId,
        proposedSplitMist: parseMist(params.proposed_split_mist, 'proposed_split_mist'),
        signer: context.keypair as never,
      });
      return {
        action: 'respond',
        dispute_id: params.dispute_id,
        evidence_blob_id: evidenceBlobId,
        tx_digest: result.txDigest,
      };
    }
    case 'accept': {
      if (!params.dispute_id || !params.task_id) {
        throw new Error('dispute_id and task_id are required when action=accept');
      }
      const result = await client.acceptResolution({
        disputeId: params.dispute_id,
        taskId: params.task_id,
        signer: context.keypair as never,
      });
      return {
        action: 'accept',
        dispute_id: params.dispute_id,
        task_id: params.task_id,
        requester_amount_mist: result.requesterAmount.toString(),
        provider_amount_mist: result.providerAmount.toString(),
        tx_digest: result.txDigest,
      };
    }
    case 'status': {
      if ((params.dispute_id ? 1 : 0) + (params.task_id ? 1 : 0) !== 1) {
        throw new Error('Provide exactly one of dispute_id or task_id when action=status');
      }
      const dispute = params.dispute_id
        ? await client.getDispute(params.dispute_id)
        : await client.getDisputeByTask(params.task_id as string);
      if (!dispute) {
        throw new Error(params.task_id ? `No dispute found for task ${params.task_id}.` : `Dispute ${params.dispute_id ?? ''} was not found.`);
      }
      return {
        action: 'status',
        dispute,
      };
    }
    default:
      throw new Error(`Unknown dispute action: ${String(params.action)}`);
  }
}

async function resolveEvidenceBlobId(params: MeshDisputeParams, context: MeshToolContext): Promise<string> {
  if ((params.evidence_blob_id ? 1 : 0) + (params.evidence ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of evidence or evidence_blob_id for dispute open/respond actions');
  }
  if (params.evidence_blob_id) {
    return params.evidence_blob_id;
  }
  if (!params.evidence) {
    throw new Error('evidence or evidence_blob_id is required for dispute open/respond actions');
  }
  const stored = await context.blobStore.store(new TextEncoder().encode(params.evidence));
  return stored.blobId;
}

function parseMist(value: string | number | undefined, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${field} must be a non-negative integer string.`);
}
