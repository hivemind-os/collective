import { MarketplaceClient } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

export interface MeshMarketplaceBidParams {
  task_id: string;
  bid_price_mist: string | number;
  reputation_score?: string | number;
  evidence?: string;
}

export const meshMarketplaceBidTool = {
  name: 'mesh_marketplace_bid',
  description: 'Place a marketplace bid on an open task',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Open task object id' },
      bid_price_mist: { type: 'string', description: 'Bid price in MIST' },
      reputation_score: { type: 'string', description: 'Optional reputation score override' },
      evidence: { type: 'string', description: 'Optional proposal or qualifications blob content' },
    },
    required: ['task_id', 'bid_price_mist'],
  },
};

export async function runMeshMarketplaceBid(
  params: MeshMarketplaceBidParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const client = context.marketplaceClient ?? new MarketplaceClient(context.suiClient, context.networkConfig);
  const result = await client.placeBid({
    taskId: params.task_id,
    bidPriceMist: parseMist(params.bid_price_mist, 'bid_price_mist'),
    reputationScore: params.reputation_score == null ? undefined : parseMist(params.reputation_score, 'reputation_score'),
    evidenceBlob: params.evidence,
    signer: context.keypair,
  });

  return {
    bid_id: result.bidId,
    task_id: params.task_id,
    tx_digest: result.txDigest,
    reputation_score: result.reputationScore.toString(),
  };
}

function parseMist(value: string | number, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${field} must be a non-negative integer string.`);
}
