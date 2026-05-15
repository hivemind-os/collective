import type { MeshToolContext } from '../context.js';

export const meshCapabilitiesResource = {
  uri: 'mesh://capabilities',
  name: 'Capability Directory',
  description: 'Known mesh capabilities aggregated from the local agent cache',
  mimeType: 'application/json',
};

export async function readCapabilitiesResource(
  context: MeshToolContext,
): Promise<Array<{ capability: string; agent_count: number }>> {
  const counts = new Map<string, number>();

  for (const agent of context.agentCache.getAllActive(1_000)) {
    for (const capability of agent.capabilities) {
      counts.set(capability.name, (counts.get(capability.name) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([capability, agent_count]) => ({ capability, agent_count }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
}
