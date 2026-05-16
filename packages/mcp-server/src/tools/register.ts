import { PaymentRail, type Capability } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';
import { hexToBytes } from '../encryption.js';

export interface MeshRegisterParams {
  name: string;
  description: string;
  capabilities: Array<{
    name: string;
    description: string;
    version: string;
    price_mist: number;
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
      capabilities: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            version: { type: 'string' },
            price_mist: { type: 'number' },
          },
          required: ['name', 'description', 'version', 'price_mist'],
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
  const capabilities: Capability[] = params.capabilities.map((entry) => ({
    name: entry.name,
    description: entry.description,
    version: entry.version,
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: BigInt(Math.max(0, Math.floor(entry.price_mist))),
      currency: 'MIST',
    },
  }));

  const result = await context.registryClient.registerAgent({
    name: params.name,
    did: context.did,
    description: params.description,
    capabilities,
    endpoint: `mesh://agent/${context.did}`,
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
