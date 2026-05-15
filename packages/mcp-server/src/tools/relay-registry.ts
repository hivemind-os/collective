import { RelayRegistryClient } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

export interface MeshRelayRegistryParams {
  action: 'list' | 'register';
  endpoint?: string;
  stake_id?: string;
  region?: string;
  routing_fee_bps?: number;
  capabilities?: string[];
}

export const meshRelayRegistryTool = {
  name: 'mesh_relay_registry',
  description: 'List registered community relays or register this node as a relay operator',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'register'] },
      endpoint: { type: 'string', description: 'Relay websocket or HTTPS endpoint when action=register' },
      stake_id: { type: 'string', description: 'Relay stake position object id when action=register' },
      region: { type: 'string', description: 'Relay region label when action=register' },
      routing_fee_bps: { type: 'number', description: 'Routing fee in basis points when action=register' },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional relay capabilities when action=register (defaults to ["routing"])',
      },
    },
    required: ['action'],
  },
};

export async function runMeshRelayRegistry(
  params: MeshRelayRegistryParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const client = context.relayRegistryClient ?? new RelayRegistryClient(context.suiClient, context.networkConfig);

  switch (params.action) {
    case 'list': {
      const relays = await client.listRelays();
      return {
        action: 'list',
        count: relays.length,
        relays,
      };
    }
    case 'register': {
      const endpoint = requireNonEmpty(params.endpoint, 'endpoint');
      const stakeId = requireNonEmpty(params.stake_id, 'stake_id');
      const region = requireNonEmpty(params.region, 'region');
      if (params.routing_fee_bps === undefined) {
        throw new Error('routing_fee_bps is required when action=register');
      }
      if (!Number.isInteger(params.routing_fee_bps) || params.routing_fee_bps < 0 || params.routing_fee_bps > 10_000) {
        throw new Error('routing_fee_bps must be an integer between 0 and 10000');
      }
      const capabilities = normalizeCapabilities(params.capabilities);
      const result = await client.registerRelay({
        endpoint,
        stakeId,
        region,
        routingFeeBps: params.routing_fee_bps,
        capabilities,
        signer: context.keypair as never,
      });
      return {
        action: 'register',
        relay_id: result.relayId,
        tx_digest: result.txDigest,
        endpoint,
        region,
        routing_fee_bps: params.routing_fee_bps,
        capabilities,
      };
    }
    default:
      throw new Error(`Unknown relay registry action: ${String(params.action)}`);
  }
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required when action=register`);
  }
  return normalized;
}

function normalizeCapabilities(capabilities: string[] | undefined): string[] {
  const normalized = capabilities?.map((capability) => capability.trim()).filter(Boolean) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : ['routing'];
}
