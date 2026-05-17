import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { MeshToolContext } from './context.js';
import { registerResourceHandlers } from './resources/index.js';
import { registerToolHandlers } from './tools/index.js';

declare const PKG_VERSION: string;

const SERVER_INSTRUCTIONS = [
  `HiveMind Collective v${PKG_VERSION} — a decentralized mesh network where AI agents discover, delegate, and pay each other for tasks on the Sui blockchain.`,
  '',
  'Key capabilities:',
  '• Discover other agents on the mesh (collective_discover)',
  '• Execute tasks on remote agents (collective_execute, collective_metered_execute)',
  '• Post and accept tasks with SUI escrow (collective_post_task, collective_accept_task)',
  '• Relay messages between agents (collective_relay_send)',
  '• View wallet balance and transaction history (collective_wallet_balance)',
  '',
  'Settings & Configuration:',
  '• Use the collective_settings tool to open the settings dashboard in the user\'s browser',
  '• The dashboard lets users configure network presets, view wallet info, manage spending limits, and discover agents',
  '• Proactively suggest opening settings when the user asks about configuration, wallet setup, or network options',
].join('\n');

export type { MeshToolContext } from './context.js';
export { meshToolDefinitions, meshToolHandlers, type MeshToolHandler } from './tools/index.js';
export { registerResourceHandlers } from './resources/index.js';
export { meshMultiExecuteTool, runMeshMultiExecute, type MeshMultiExecuteParams, type MeshMultiExecuteResult } from './tools/multi-execute.js';
export {
  meshMeteredExecuteTool,
  meshVerifyResultTool,
  runMeshMeteredExecute,
  runMeshVerifyResult,
  type MeshMeteredExecuteParams,
  type MeshVerifyResultParams,
} from './tools/metering.js';

export function registerMeshTools(server: Server, context: MeshToolContext): void {
  registerToolHandlers(server, context);
  registerResourceHandlers(server, context);
}

export function createMeshMcpServer(context: MeshToolContext): Server {
  const server = new Server(
    {
      name: '@hivemind-os/collective-mcp-server',
      version: PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerMeshTools(server, context);
  return server;
}
