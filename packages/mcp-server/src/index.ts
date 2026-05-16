import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { MeshToolContext } from './context.js';
import { registerResourceHandlers } from './resources/index.js';
import { registerToolHandlers } from './tools/index.js';

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
      name: '@agentic-mesh/mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  registerMeshTools(server, context);
  return server;
}
