import type { MeshToolContext } from '../context.js';

export interface MeshDeactivateParams {
  agent_card_id: string;
}

export const meshDeactivateTool = {
  name: 'mesh_deactivate',
  description: 'Deactivate an existing agent card',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agent_card_id: { type: 'string', description: 'Agent card object id' },
    },
    required: ['agent_card_id'],
  },
};

export async function runMeshDeactivate(
  params: MeshDeactivateParams,
  context: MeshToolContext,
): Promise<{ tx_digest: string; status: 'deactivated' }> {
  const result = await context.registryClient.deactivateAgent({
    cardId: params.agent_card_id,
    keypair: context.keypair,
  });
  context.agentCache.removeAgent(params.agent_card_id);

  return {
    tx_digest: result.txDigest,
    status: 'deactivated',
  };
}
