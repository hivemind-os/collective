import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { MeshToolContext } from '../context.js';
import { meshBalanceTool, runMeshBalance } from './balance.js';
import { meshDeactivateTool, runMeshDeactivate } from './deactivate.js';
import { meshDiscoverTool, runMeshDiscover } from './discover.js';
import { meshDisputeTool, runMeshDispute } from './dispute.js';
import { meshExecuteAsyncTool, runMeshExecuteAsync } from './execute-async.js';
import { meshExecuteTool, runMeshExecute } from './execute.js';
import { meshMarketplaceAcceptBidTool, runMeshMarketplaceAcceptBid } from './marketplace-accept-bid.js';
import { meshMarketplaceBidTool, runMeshMarketplaceBid } from './marketplace-bid.js';
import { meshMarketplaceBrowseTool, runMeshMarketplaceBrowse } from './marketplace-browse.js';
import { meshMarketplacePostTool, runMeshMarketplacePost } from './marketplace-post.js';
import { meshPolicyUpdateTool, runMeshPolicyUpdate } from './policy-update.js';
import { meshRegisterTool, runMeshRegister } from './register.js';
import { meshStakeTool, runMeshStake } from './stake.js';
import { meshTaskHistoryTool, runMeshTaskHistory } from './task-history.js';
import { meshTaskStatusTool, runMeshTaskStatus } from './task-status.js';

const toolDefinitions = [
  meshDiscoverTool,
  meshDisputeTool,
  meshExecuteTool,
  meshExecuteAsyncTool,
  meshMarketplacePostTool,
  meshMarketplaceBrowseTool,
  meshMarketplaceBidTool,
  meshMarketplaceAcceptBidTool,
  meshTaskStatusTool,
  meshRegisterTool,
  meshDeactivateTool,
  meshBalanceTool,
  meshPolicyUpdateTool,
  meshStakeTool,
  meshTaskHistoryTool,
];

const toolHandlers: Record<string, (params: unknown, context: MeshToolContext) => Promise<unknown>> = {
  [meshDiscoverTool.name]: runMeshDiscover,
  [meshDisputeTool.name]: runMeshDispute,
  [meshExecuteTool.name]: runMeshExecute,
  [meshExecuteAsyncTool.name]: runMeshExecuteAsync,
  [meshMarketplacePostTool.name]: runMeshMarketplacePost,
  [meshMarketplaceBrowseTool.name]: runMeshMarketplaceBrowse,
  [meshMarketplaceBidTool.name]: runMeshMarketplaceBid,
  [meshMarketplaceAcceptBidTool.name]: runMeshMarketplaceAcceptBid,
  [meshTaskStatusTool.name]: runMeshTaskStatus,
  [meshRegisterTool.name]: runMeshRegister,
  [meshDeactivateTool.name]: runMeshDeactivate,
  [meshBalanceTool.name]: runMeshBalance,
  [meshPolicyUpdateTool.name]: runMeshPolicyUpdate,
  [meshStakeTool.name]: runMeshStake,
  [meshTaskHistoryTool.name]: runMeshTaskHistory,
};

export function registerToolHandlers(server: Server, context: MeshToolContext): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = toolHandlers[request.params.name];
    if (!handler) {
      return createErrorResult(`Unknown tool: ${request.params.name}`);
    }

    try {
      const response = await handler((request.params.arguments ?? {}) as never, context);
      return createSuccessResult(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResult(message);
    }
  });
}

export const meshToolDefinitions = toolDefinitions;

function createSuccessResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: serialize(payload),
      },
    ],
  };
}

function createErrorResult(message: string): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: serialize({ error: message }),
      },
    ],
  };
}

function serialize(payload: unknown): string {
  return JSON.stringify(payload, bigintReplacer, 2);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
