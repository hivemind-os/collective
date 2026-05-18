import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { SessionExpiredError } from '@hivemind-os/collective-core';

import type { MeshToolContext } from '../context.js';
import { meshAnalyticsTool, runMeshAnalytics } from './analytics.js';
import { meshBalanceTool, runMeshBalance } from './balance.js';
import { meshDeactivateTool, runMeshDeactivate } from './deactivate.js';
import { meshDiscoverTool, runMeshDiscover } from './discover.js';
import { meshDisputeTool, runMeshDispute } from './dispute.js';
import { meshExecuteAsyncTool, runMeshExecuteAsync } from './execute-async.js';
import { meshExecuteTool, runMeshExecute } from './execute.js';
import { meshMeteredExecuteTool, meshVerifyResultTool, runMeshMeteredExecute, runMeshVerifyResult } from './metering.js';
import { meshMarketplaceAcceptBidTool, runMeshMarketplaceAcceptBid } from './marketplace-accept-bid.js';
import { meshMarketplaceBidTool, runMeshMarketplaceBid } from './marketplace-bid.js';
import { meshMarketplaceBrowseTool, runMeshMarketplaceBrowse } from './marketplace-browse.js';
import { meshMarketplacePostTool, runMeshMarketplacePost } from './marketplace-post.js';
import { meshMultiExecuteTool, runMeshMultiExecute } from './multi-execute.js';
import { meshPolicyUpdateTool, runMeshPolicyUpdate } from './policy-update.js';
import { meshProviderConfigTool, runMeshProviderConfig } from './provider-config.js';
import { meshRegisterTool, runMeshRegister } from './register.js';
import { meshRelayRegistryTool, runMeshRelayRegistry } from './relay-registry.js';
import { meshSettingsTool, runMeshSettings } from './settings.js';
import { meshStakeTool, runMeshStake } from './stake.js';
import { meshTaskHistoryTool, runMeshTaskHistory } from './task-history.js';
import { meshTaskStatusTool, runMeshTaskStatus } from './task-status.js';
import { meshWithdrawTool, runMeshWithdraw } from './withdraw.js';
import { meshWorkQueueTool, runMeshWorkQueue } from './work-queue.js';

const toolDefinitions = [
  meshAnalyticsTool,
  meshDiscoverTool,
  meshDisputeTool,
  meshExecuteTool,
  meshExecuteAsyncTool,
  meshMeteredExecuteTool,
  meshVerifyResultTool,
  meshMarketplacePostTool,
  meshMarketplaceBrowseTool,
  meshMultiExecuteTool,
  meshMarketplaceBidTool,
  meshMarketplaceAcceptBidTool,
  meshTaskStatusTool,
  meshRegisterTool,
  meshDeactivateTool,
  meshBalanceTool,
  meshPolicyUpdateTool,
  meshStakeTool,
  meshRelayRegistryTool,
  meshTaskHistoryTool,
  meshSettingsTool,
  meshProviderConfigTool,
  meshWithdrawTool,
  meshWorkQueueTool,
];

export type MeshToolHandler = (params: never, context: MeshToolContext) => Promise<unknown>;

export const meshToolHandlers: Record<string, MeshToolHandler> = {
  [meshAnalyticsTool.name]: runMeshAnalytics,
  [meshDiscoverTool.name]: runMeshDiscover,
  [meshDisputeTool.name]: runMeshDispute,
  [meshExecuteTool.name]: runMeshExecute,
  [meshExecuteAsyncTool.name]: runMeshExecuteAsync,
  [meshMeteredExecuteTool.name]: runMeshMeteredExecute,
  [meshVerifyResultTool.name]: runMeshVerifyResult,
  [meshMarketplacePostTool.name]: runMeshMarketplacePost,
  [meshMarketplaceBrowseTool.name]: runMeshMarketplaceBrowse,
  [meshMultiExecuteTool.name]: runMeshMultiExecute,
  [meshMarketplaceBidTool.name]: runMeshMarketplaceBid,
  [meshMarketplaceAcceptBidTool.name]: runMeshMarketplaceAcceptBid,
  [meshTaskStatusTool.name]: runMeshTaskStatus,
  [meshRegisterTool.name]: runMeshRegister,
  [meshDeactivateTool.name]: runMeshDeactivate,
  [meshBalanceTool.name]: runMeshBalance,
  [meshPolicyUpdateTool.name]: runMeshPolicyUpdate,
  [meshStakeTool.name]: runMeshStake,
  [meshRelayRegistryTool.name]: runMeshRelayRegistry,
  [meshTaskHistoryTool.name]: runMeshTaskHistory,
  [meshSettingsTool.name]: runMeshSettings,
  [meshProviderConfigTool.name]: runMeshProviderConfig,
  [meshWithdrawTool.name]: runMeshWithdraw,
  [meshWorkQueueTool.name]: runMeshWorkQueue,
};

export function registerToolHandlers(server: Server, context: MeshToolContext): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = meshToolHandlers[request.params.name];
    if (!handler) {
      return createErrorResult(`Unknown tool: ${request.params.name}`);
    }

    try {
      const response = await handler((request.params.arguments ?? {}) as never, context);
      return createSuccessResult(response);
    } catch (error) {
      const message =
        error instanceof SessionExpiredError
          ? 'Authentication expired. Please re-authenticate via the daemon portal.'
          : error instanceof Error
            ? error.message
            : String(error);
      const sessionState = await getSessionState(context);
      return createErrorResult(
        sessionState ? `${message} (session state: ${sessionState})` : message,
        sessionState ? { session_state: sessionState, reauth_required: error instanceof SessionExpiredError } : undefined,
      );
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

function createErrorResult(
  message: string,
  details?: Record<string, unknown>,
): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: serialize({ error: message, ...details }),
      },
    ],
  };
}

async function getSessionState(context: MeshToolContext): Promise<string | null> {
  const provider = context.authProvider;
  if (!provider?.getSessionState) {
    return null;
  }

  const state = await provider.getSessionState();
  return typeof state === 'string' ? state : null;
}

function serialize(payload: unknown): string {
  return JSON.stringify(payload, bigintReplacer, 2);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
