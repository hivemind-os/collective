import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { MeshToolContext } from '../context.js';
import { readAgentResource, meshAgentResourceTemplate } from './agent.js';
import { readCapabilitiesResource, meshCapabilitiesResource } from './capabilities.js';
import { readTaskResource, meshTaskResourceTemplate } from './task.js';
import { readWalletResource, meshWalletResource } from './wallet.js';

const staticResources = [meshCapabilitiesResource, meshWalletResource];
const resourceTemplates = [meshAgentResourceTemplate, meshTaskResourceTemplate];

export function registerResourceHandlers(server: Server, context: MeshToolContext): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: staticResources,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const data = await routeResourceRead(uri, context);

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: serialize(data),
        },
      ],
    };
  });
}

export const meshResourceDefinitions = {
  resources: staticResources,
  templates: resourceTemplates,
};

async function routeResourceRead(uri: string, context: MeshToolContext): Promise<unknown> {
  const parsed = new URL(uri);

  switch (parsed.host) {
    case 'capabilities':
      return readCapabilitiesResource(context);
    case 'wallet':
      return readWalletResource(context);
    case 'agent':
      return readAgentResource(decodeURIComponent(parsed.pathname.replace(/^\//, '')), context);
    case 'task':
      return readTaskResource(decodeURIComponent(parsed.pathname.replace(/^\//, '')), context);
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

function serialize(payload: unknown): string {
  return JSON.stringify(payload, bigintReplacer, 2);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
