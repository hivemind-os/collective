import { MarketplaceClient } from '@hivemind-os/collective-core';

import type { MeshToolContext } from '../context.js';

export interface MeshMarketplaceBrowseParams {
  category?: string;
  min_price_mist?: string | number;
  max_price_mist?: string | number;
  limit?: number;
}

export const meshMarketplaceBrowseTool = {
  name: 'collective_marketplace_browse',
  description: 'Browse open marketplace tasks by category and price filters',
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: { type: 'string', description: 'Optional marketplace category filter' },
      min_price_mist: { type: 'string', description: 'Optional minimum escrow budget in MIST' },
      max_price_mist: { type: 'string', description: 'Optional maximum escrow budget in MIST' },
      limit: { type: 'number', description: 'Maximum number of open tasks to return (default 20)' },
    },
    required: [],
  },
};

export async function runMeshMarketplaceBrowse(
  params: MeshMarketplaceBrowseParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const client = context.marketplaceClient ?? new MarketplaceClient(context.suiClient, context.networkConfig);
  const tasks = await client.browseOpenTasks({
    category: params.category,
    minPriceMist: parseOptionalMist(params.min_price_mist),
    maxPriceMist: parseOptionalMist(params.max_price_mist),
    limit: normalizeLimit(params.limit),
  });

  return {
    tasks,
    count: tasks.length,
  };
}

function parseOptionalMist(value: string | number | undefined): bigint | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error('Price filters must be non-negative integer strings.');
}

function normalizeLimit(limit?: number): number {
  if (limit == null) {
    return 20;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer.');
  }
  return limit;
}
