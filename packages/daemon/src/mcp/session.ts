import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage as SdkJsonRpcMessage } from '@modelcontextprotocol/sdk/types.js';
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
  private readonly server: McpServer;
  private readonly transport: IpcTransport;
  private readonly state: DaemonState;
  private readonly getStatus: () => McpSessionStatus;
  private readonly getAppName: () => string;
  private initializePromise?: Promise<void>;

  constructor(params: {
    state: DaemonState;
    emit: (message: JsonRpcMessage) => Promise<void> | void;
    getStatus: () => McpSessionStatus;
    getAppName: () => string;
  }) {
    this.state = params.state;
    this.getStatus = params.getStatus;
    this.getAppName = params.getAppName;
    this.server = new McpServer({
      name: '@agentic-mesh/daemon',
      version: '0.1.0',
    });
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

  private registerTools(): void {
    this.server.tool('mesh_balance', 'Return the daemon wallet SUI balance.', async () => {
      const balanceMist = await this.state.suiClient.getBalance(this.state.address);
      return createToolResult(
        `Wallet ${this.state.address} balance: ${balanceMist.toString()} MIST`,
        {
          did: this.state.did,
          address: this.state.address,
          balanceMist: balanceMist.toString(),
        },
      );
    });

    this.server.tool('mesh_status', 'Return daemon identity, uptime, and connected apps.', async () => {
      const status = this.getStatus();
      return createToolResult(`Daemon ${status.did} has ${status.connectedApps.length} connected app(s).`, {
        ...status,
        connectedApps: status.connectedApps.map((app) => ({
          ...app,
          pid: app.appPid,
        })),
      });
    });
  }
}

function createToolResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  } as CallToolResult;
}

function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}
