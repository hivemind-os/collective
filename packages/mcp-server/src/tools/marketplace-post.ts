import { MarketplaceClient } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

const DEFAULT_DISPUTE_WINDOW_MS = 60_000;
const DEFAULT_EXPIRY_HOURS = 24;

export interface MeshMarketplacePostParams {
  capability: string;
  category: string;
  price_mist: string | number;
  input?: string;
  input_blob_id?: string;
  agreement_hash?: string;
  dispute_window_ms?: number;
  expiry_hours?: number;
}

export const meshMarketplacePostTool = {
  name: 'mesh_marketplace_post',
  description: 'Post an open marketplace task with category metadata',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability requested for the task' },
      category: { type: 'string', description: 'Marketplace category used for browsing' },
      price_mist: { type: 'string', description: 'Escrowed task budget in MIST' },
      input: { type: 'string', description: 'Inline task input to upload to blob storage' },
      input_blob_id: { type: 'string', description: 'Existing blob id containing task input' },
      agreement_hash: { type: 'string', description: 'Optional agreement hash or plaintext summary' },
      dispute_window_ms: { type: 'number', description: 'Optional dispute window override in milliseconds' },
      expiry_hours: { type: 'number', description: 'Optional task expiry in hours' },
    },
    required: ['capability', 'category', 'price_mist'],
  },
};

export async function runMeshMarketplacePost(
  params: MeshMarketplacePostParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const client = context.marketplaceClient ?? new MarketplaceClient(context.suiClient, context.networkConfig);
  const inputBlobId = await resolveInputBlobId(params, context);
  const result = await client.postOpenTask({
    capability: params.capability,
    category: params.category,
    inputBlobId,
    agreementHash: params.agreement_hash,
    priceMist: parseMist(params.price_mist, 'price_mist'),
    disputeWindowMs: normalizeNonNegativeInteger(params.dispute_window_ms, DEFAULT_DISPUTE_WINDOW_MS, 'dispute_window_ms'),
    expiryHours: normalizeNonNegativeInteger(params.expiry_hours, DEFAULT_EXPIRY_HOURS, 'expiry_hours'),
    signer: context.keypair,
  });

  return {
    task_id: result.taskId,
    tx_digest: result.txDigest,
    capability: params.capability,
    category: params.category,
    input_blob_id: inputBlobId,
  };
}

async function resolveInputBlobId(params: MeshMarketplacePostParams, context: MeshToolContext): Promise<string> {
  if ((params.input_blob_id ? 1 : 0) + (params.input ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of input or input_blob_id when posting a marketplace task');
  }
  if (params.input_blob_id) {
    return params.input_blob_id;
  }
  if (!params.input) {
    throw new Error('input or input_blob_id is required when posting a marketplace task');
  }
  const stored = await context.blobStore.store(new TextEncoder().encode(params.input));
  return stored.blobId;
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

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}
