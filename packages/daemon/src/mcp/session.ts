import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage as SdkJsonRpcMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionExpiredError } from '@agentic-mesh/core';
import {
  meshToolDefinitions,
  meshToolHandlers,
  registerResourceHandlers,
  type MeshToolContext,
} from '@agentic-mesh/mcp-server';
import { PaymentRail } from '@agentic-mesh/types';

import { logAuditEvent } from '../audit.js';
import type { ConnectedApp } from '../ipc/connection-registry.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../ipc/protocol.js';
import { isJsonRpcRequest } from '../ipc/protocol.js';
import type { DaemonState } from '../state.js';

class IpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: SdkJsonRpcMessage) => void;
  sessionId = randomUUID();

  private closed = false;
  private readonly pendingResponses = new Map<string | number, (message: JsonRpcResponse) => void>();

  constructor(private readonly emit: (message: JsonRpcMessage) => Promise<void> | void) {}

  async start(): Promise<void> {
    return;
  }

  async send(message: SdkJsonRpcMessage): Promise<void> {
    const jsonRpcMessage = message as unknown as JsonRpcMessage;
    if (isJsonRpcResponse(jsonRpcMessage) && jsonRpcMessage.id !== null) {
      this.pendingResponses.get(jsonRpcMessage.id)?.(jsonRpcMessage);
      this.pendingResponses.delete(jsonRpcMessage.id);
    }

    await this.emit(jsonRpcMessage);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pendingResponses.clear();
    this.onclose?.();
  }

  async dispatch(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed.');
    }

    this.onmessage?.(message as unknown as SdkJsonRpcMessage);
  }

  waitForResponse(id: string | number): Promise<JsonRpcResponse> {
    return new Promise((resolvePromise) => {
      this.pendingResponses.set(id, resolvePromise);
    });
  }
}

export interface McpSessionStatus {
  did: string;
  address: string;
  uptime: number;
  connectedApps: ConnectedApp[];
  spendingToday: string;
  providerRunning: boolean;
}

export class McpSession {
  private readonly server: Server;
  private readonly transport: IpcTransport;
  private readonly state: DaemonState;
  private readonly getStatus: () => McpSessionStatus;
  private readonly getAppName: () => string;
  private readonly toolContext?: MeshToolContext;
  private initializePromise?: Promise<void>;

  constructor(params: {
    state: DaemonState;
    emit: (message: JsonRpcMessage) => Promise<void> | void;
    getStatus: () => McpSessionStatus;
    getAppName: () => string;
    toolContext?: MeshToolContext;
  }) {
    this.state = params.state;
    this.getStatus = params.getStatus;
    this.getAppName = params.getAppName;
    this.toolContext = params.toolContext;
    this.server = new Server(
      { name: '@agentic-mesh/daemon', version: '0.1.0' },
      {
        capabilities: {
          tools: {},
          ...(params.toolContext ? { resources: {} } : {}),
        },
      },
    );
    this.transport = new IpcTransport(params.emit);
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.registerTools();
    this.initializePromise = this.server.connect(this.transport);
    await this.initializePromise;
  }

  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (isJsonRpcRequest(message)) {
      const responsePromise = this.transport.waitForResponse(message.id);
      await this.transport.dispatch(message);
      return responsePromise;
    }

    await this.transport.dispatch(message);
    return null;
  }

  evaluateSpending(request: { amountMist: bigint; rail: PaymentRail; appId?: string }) {
    return this.state.spendingPolicy.evaluate({
      ...request,
      originAppName: this.getAppName(),
    });
  }

  recordSpending(entry: { amountMist: bigint; rail: PaymentRail; taskId: string; appId?: string }): void {
    const appName = this.getAppName();
    logAuditEvent({
      event: 'spending',
      appName,
      amount: entry.amountMist.toString(),
      taskId: entry.taskId,
    });
    this.state.spendingPolicy.record({
      ...entry,
      originAppName: appName,
    });
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  /** Expose the low-level MCP Server for sampling requests. */
  get mcpServer(): Server {
    return this.server;
  }

  private registerTools(): void {
    const daemonToolDefs = [
      {
        name: 'mesh_balance',
        description: 'Return the daemon wallet SUI balance, address, and DID.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'mesh_status',
        description: 'Return daemon identity, uptime, and connected apps.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ];

    const daemonToolHandlers: Record<string, () => Promise<unknown>> = {
      mesh_balance: async () => {
        const balanceMist = await this.state.suiClient.getBalance(this.state.address);
        return {
          did: this.state.did,
          address: this.state.address,
          balanceMist: balanceMist.toString(),
        };
      },
      mesh_status: async () => {
        const status = this.getStatus();
        return {
          ...status,
          connectedApps: status.connectedApps.map((app) => ({ ...app, pid: app.appPid })),
        };
      },
    };

    // Merge: daemon-specific tools + mcp-server tools (skip mcp-server's mesh_balance)
    const allToolDefs = [
      ...daemonToolDefs,
      ...meshToolDefinitions.filter((def) => !daemonToolHandlers[def.name]),
    ];

    const context = this.toolContext;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allToolDefs,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;

      // Daemon-specific handlers
      const daemonHandler = daemonToolHandlers[toolName];
      if (daemonHandler) {
        try {
          const result = await daemonHandler();
          return createDaemonToolResult(result as Record<string, unknown>);
        } catch (error) {
          return createErrorResult(error instanceof Error ? error.message : String(error));
        }
      }

      // mcp-server handlers
      const meshHandler = meshToolHandlers[toolName];
      if (meshHandler && context) {
        try {
          const result = await meshHandler((request.params.arguments ?? {}) as never, context);
          return createSuccessResult(result);
        } catch (error) {
          const message =
            error instanceof SessionExpiredError
              ? 'Authentication expired. Please re-authenticate via the daemon portal.'
              : error instanceof Error
                ? error.message
                : String(error);
          return createErrorResult(message);
        }
      }

      return createErrorResult(`Unknown tool: ${toolName}`);
    });

    // Register resource handlers (capabilities, wallet, agent, task resources)
    if (context) {
      registerResourceHandlers(this.server, context);
    }
  }
}

function createDaemonToolResult(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: serialize(payload) }],
    structuredContent: payload,
  };
}

function createSuccessResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: serialize(payload) }],
  };
}

function createErrorResult(message: string): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: 'text', text: serialize({ error: message }) }],
  };
}

function serialize(payload: unknown): string {
  return JSON.stringify(payload, bigintReplacer, 2);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}
