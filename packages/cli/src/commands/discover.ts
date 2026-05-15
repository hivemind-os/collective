import { MeshSuiClient, RegistryClient } from '@agentic-mesh/core';

import { loadMeshConfig } from './config.js';
import { formatMistToSui } from './wallet.js';
import { info, table } from '../utils/output.js';

export async function handleDiscover(args: string[]): Promise<number> {
  const capability = args[0]?.trim();
  if (!capability) {
    throw new Error('Usage: mesh discover <capability>');
  }

  const config = loadMeshConfig();
  if (!config.network.packageId || !config.network.registryId) {
    throw new Error('network.packageId and network.registryId must be configured before discovery.');
  }

  const registryClient = new RegistryClient(new MeshSuiClient(config.network), config.network);
  const agents = await registryClient.discoverByCapability(capability);
  info(`Found ${agents.length} provider(s) for ${capability}`);
  table(
    ['Name', 'DID', 'Price (SUI)', 'Endpoint'],
    agents.map((agent) => {
      const matched = agent.capabilities.find((entry) => entry.name.toLowerCase() === capability.toLowerCase());
      return [
        agent.name,
        agent.did,
        matched ? formatMistToSui(matched.pricing.amount) : '-',
        agent.endpoint ?? '-',
      ];
    }),
  );
  return 0;
}
