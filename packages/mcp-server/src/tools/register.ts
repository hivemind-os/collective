import { PaymentRail, type Capability } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';
import { hexToBytes } from '../encryption.js';

export interface MeshRegisterParams {
  name: string;
  description: string;
  payout_address?: string;
  capabilities: Array<{
    name: string;
    description: string;
    version: string;
    price_mist?: number;
    price?: number;
    currency?: string;
  }>;
}

export const meshRegisterTool = {
  name: 'collective_register',
  description: 'Register the current daemon identity as a provider',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Display name for the agent' },
      description: { type: 'string', description: 'Agent description' },
      payout_address: { type: 'string', description: 'Sui address where earnings will be sent (defaults to agent address)' },
      capabilities: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            version: { type: 'string' },
            price: { type: 'number', description: 'Price amount (in USDC by default, or MIST if currency is SUI/MIST)' },
            price_mist: { type: 'number', description: 'DEPRECATED — use price + currency instead' },
            currency: { type: 'string', enum: ['USDC', 'MIST', 'SUI'], description: 'Currency for the price (default: USDC)' },
          },
          required: ['name', 'description', 'version'],
        },
      },
    },
    required: ['name', 'description', 'capabilities'],
  },
};

export async function runMeshRegister(
  params: MeshRegisterParams,
  context: MeshToolContext,
): Promise<{ agent_card_id: string; did: string; tx_digest: string }> {
  const capabilities: Capability[] = params.capabilities.map((entry) => {
    const currency = entry.currency ?? (entry.price_mist !== undefined ? 'MIST' : 'USDC');
    const rawPrice = entry.price ?? entry.price_mist ?? 0;
    const amount = BigInt(Math.max(0, Math.floor(rawPrice)));
    const rail = currency === 'USDC' ? PaymentRail.USDC_ESCROW : PaymentRail.SUI_ESCROW;
    return {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      pricing: { rail, amount, currency },
    };
  });

  const result = await context.registryClient.registerAgent({
    name: params.name,
    did: context.did,
    description: params.description,
    capabilities,
    endpoint: `mesh://agent/${context.did}`,
    payoutAddress: params.payout_address,
    encryptionPublicKey: context.encryption?.enabled ? (hexToBytes(context.encryption.publicKey) ?? undefined) : undefined,
    keypair: context.keypair,
  });

  const card = await context.registryClient.getAgentCard(result.agentCardId);
  if (card) {
    context.agentCache.upsertAgent(card);
  }

  return {
    agent_card_id: result.agentCardId,
    did: context.did,
    tx_digest: result.txDigest,
  };
}
