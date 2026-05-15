import { MarketplaceClient } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

export interface MeshMarketplaceAcceptBidParams {
  task_id: string;
  bid_id: string;
  reject_competing?: boolean;
}

export const meshMarketplaceAcceptBidTool = {
  name: 'mesh_marketplace_accept_bid',
  description: 'Accept a marketplace bid and optionally reject competing bids',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Marketplace task id' },
      bid_id: { type: 'string', description: 'Bid id to accept' },
      reject_competing: { type: 'boolean', description: 'Reject other active bids in the same transaction (default true)' },
    },
    required: ['task_id', 'bid_id'],
  },
};

export async function runMeshMarketplaceAcceptBid(
  params: MeshMarketplaceAcceptBidParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const client = context.marketplaceClient ?? new MarketplaceClient(context.suiClient, context.networkConfig);
  const result = await client.acceptBid({
    taskId: params.task_id,
    bidId: params.bid_id,
    rejectCompeting: params.reject_competing,
    signer: context.keypair,
  });

  return {
    task_id: params.task_id,
    bid_id: params.bid_id,
    rejected_bid_ids: result.rejectedBidIds,
    tx_digest: result.txDigest,
  };
}
