import type { AgentCard } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';

export const meshAgentResourceTemplate = {
  uriTemplate: 'mesh://agent/{did}',
  name: 'Agent Profile',
  description: 'Resolve a mesh agent profile by DID',
  mimeType: 'application/json',
};

export async function readAgentResource(did: string, context: MeshToolContext): Promise<AgentCard> {
  const cached = context.agentCache.getAgentByDID(did);
  if (cached) {
    return cached;
  }

  const discovered = await findAgentByDidOnChain(did, context);
  if (!discovered) {
    throw new Error(`Agent ${did} was not found.`);
  }

  context.agentCache.upsertAgent(discovered);
  return discovered;
}

async function findAgentByDidOnChain(
  did: string,
  context: MeshToolContext,
): Promise<AgentCard | null> {
  const eventType = `${context.networkConfig.packageId}::registry::AgentRegistered`;
  let cursor: unknown = null;

  while (true) {
    const page = await context.suiClient.queryEvents(eventType, cursor as never, 50);
    for (const event of page.events) {
      if (!isRecord(event.parsedJson)) {
        continue;
      }

      if (!stringEquals(readString(event.parsedJson.did), did)) {
        continue;
      }

      const cardId = readString(event.parsedJson.id, event.parsedJson.card_id, event.parsedJson.cardId);
      if (!cardId) {
        continue;
      }

      const card = await context.registryClient.getAgentCard(cardId);
      if (card) {
        return card;
      }
    }

    if (!page.hasMore || !page.nextCursor) {
      break;
    }

    cursor = page.nextCursor;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(...values: unknown[]): string {
  const match = values.find((value) => typeof value === 'string');
  return typeof match === 'string' ? match : '';
}

function stringEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
