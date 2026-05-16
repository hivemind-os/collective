import { randomUUID } from 'node:crypto';
import net from 'node:net';

import pino from 'pino';

import { logAuditEvent } from '../audit.js';
import type { DaemonAuthStatus } from '../auth/session-monitor.js';
import { McpSession, type McpSessionStatus } from '../mcp/session.js';
import type { DaemonState } from '../state.js';
import type { ConnectedAppMetadata } from './connection-registry.js';
import type { ClientValidationResult } from './pipe-security.js';
import {
  createErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  parseMessage,
  serializeResponse,
  type JsonRpcMessage,
} from './protocol.js';

const logger = pino({ name: '@agentic-mesh/daemon:connection' });

interface ConnectionOptions {
  getStatus: () => McpSessionStatus;
  getAuthStatus: () => DaemonAuthStatus;
  triggerReauth: () => Promise<{ portalUrl: string | null; browserOpened: boolean; status: DaemonAuthStatus }>;
  validateClient: (metadata: ConnectedAppMetadata) => Promise<ClientValidationResult>;
  onHello: (metadata: ConnectedAppMetadata) => void;
  onClose: () => void;
}

export class Connection {
  readonly id = randomUUID();
  readonly connectedAt = Date.now();

  private appName?: string;
  private appPid?: number;
  private profile?: string;
  private readonly session: McpSession;
  private readonly sessionReady: Promise<void>;
  private buffer = '';
  private helloReceived = false;
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly state: DaemonState,
    private readonly options: ConnectionOptions,
  ) {
    this.socket.setEncoding('utf8');
    this.socket.setNoDelay(true);
    this.session = new McpSession({
      state: this.state,
      emit: async (message) => {
        this.sendMessage(message);
      },
      getStatus: this.options.getStatus,
      getAppName: () => this.appName ?? 'unknown',
    });
    this.sessionReady = this.session.initialize();
    this.socket.on('data', (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });
    this.socket.on('close', () => {
      this.close();
    });
    this.socket.on('end', () => {
      this.close();
    });
    this.socket.on('error', (error) => {
      logger.debug({ err: error, connectionId: this.id }, 'Socket error.');
      this.close();
    });
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        const message = parseMessage(line);
        if (!message) {
          this.sendMessage(createErrorResponse(null, -32700, 'Parse error'));
        } else {
          void this.handleMessage(message).catch((error) => {
            logger.error({ err: error, connectionId: this.id }, 'Failed to handle IPC message.');
            if (isJsonRpcRequest(message)) {
              this.sendMessage(createErrorResponse(message.id, -32603, 'Internal error'));
            }
          });
        }
      }

      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcRequest(message) && message.method === 'shim_hello') {
      if (this.helloReceived) {
        this.sendMessage(createErrorResponse(message.id, -32600, 'shim_hello has already been received'));
        return;
      }

      await this.handleShimHello(message.id, message.params);
      return;
    }

    if (!this.helloReceived) {
      if (isJsonRpcRequest(message)) {
        this.sendMessage(createErrorResponse(message.id, -32000, 'Expected shim_hello as the first message'));
      }
      return;
    }

    if (isJsonRpcRequest(message) && message.method === 'daemon_status') {
      this.handleDaemonStatus(message.id);
      return;
    }

    if (isJsonRpcRequest(message) && message.method === 'auth.status') {
      this.handleAuthStatus(message.id);
      return;
    }

    if (isJsonRpcRequest(message) && message.method === 'auth.reauth') {
      await this.handleAuthReauth(message.id);
      return;
    }

    await this.handleMcpMessage(message);
  }

  private async handleShimHello(id: string | number, params: unknown): Promise<void> {
    if (!isRecord(params)) {
      this.sendMessage(createErrorResponse(id, -32602, 'shim_hello requires app metadata'));
      return;
    }

    const appPid = readPid(params.pid ?? params.appPid);
    const appName = readString(params.appName) ?? readString(params.clientName) ?? inferAppName(appPid);
    const profile = readString(params.profile);
    if (!appName || appPid === undefined) {
      this.sendMessage(createErrorResponse(id, -32602, 'shim_hello requires appName and pid'));
      return;
    }

    const validation = await this.options.validateClient({
      appName,
      appPid,
      profile,
    });
    if (!validation.allowed) {
      logger.warn(
        {
          connectionId: this.id,
          appName,
          appPid,
          expectedUser: validation.expectedUser,
          actualUser: validation.actualUser,
          reason: validation.reason,
        },
        'IPC client validation failed.',
      );
      this.rejectAndClose(id, validation.reason ?? 'IPC client validation failed.');
      return;
    }

    this.appName = appName;
    this.appPid = appPid;
    this.profile = profile;
    this.helloReceived = true;
    this.options.onHello({
      appName: this.appName,
      appPid: this.appPid,
      profile: this.profile,
    });
    logAuditEvent({
      event: 'app_connected',
      appName: this.appName,
      appPid: this.appPid,
      connectionId: this.id,
    });

    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result: {
        acknowledged: true,
        connectionId: this.id,
      },
    });
  }

  private handleDaemonStatus(id: string | number): void {
    const status = this.options.getStatus();
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result: {
        did: status.did,
        uptime: status.uptime,
        connectedApps: status.connectedApps.map((app) => ({
          appName: app.appName,
          connectedAt: app.connectedAt,
        })),
        spendingToday: status.spendingToday,
        providerRunning: status.providerRunning,
      },
    });
  }

  private handleAuthStatus(id: string | number): void {
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result: this.options.getAuthStatus(),
    });
  }

  private async handleAuthReauth(id: string | number): Promise<void> {
    const result = await this.options.triggerReauth();
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private async handleMcpMessage(message: JsonRpcMessage): Promise<void> {
    await this.sessionReady;

    try {
      if (isJsonRpcRequest(message)) {
        const toolCall = parseToolCall(message);
        if (toolCall) {
          logAuditEvent({
            event: 'tool_call',
            appName: this.appName ?? 'unknown',
            tool: toolCall.tool,
            taskId: toolCall.taskId,
          });
        }
      }

      await this.session.handleMessage(message);
    } catch (error) {
      logger.error({ err: error, connectionId: this.id }, 'MCP session error.');
      if (isJsonRpcRequest(message)) {
        this.sendMessage(createErrorResponse(message.id, -32603, 'MCP session error'));
      } else if (isJsonRpcNotification(message)) {
        this.close();
      }
    }
  }

  sendNotification(method: string, params?: unknown): void {
    this.sendMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.options.onClose();
    if (this.appName) {
      logAuditEvent({
        event: 'app_disconnected',
        appName: this.appName,
        connectionId: this.id,
        duration: Date.now() - this.connectedAt,
      });
    }
    void this.session.close().catch((error) => {
      logger.debug({ err: error, connectionId: this.id }, 'Failed to close MCP session cleanly.');
    });
    if (!this.socket.destroyed && !this.socket.writableEnded) {
      this.socket.destroy();
    }
  }

  private rejectAndClose(id: string | number, message: string): void {
    if (this.closed || this.socket.destroyed) {
      return;
    }

    this.socket.end(`${serializeResponse(createErrorResponse(id, -32001, message))}\n`);
    this.close();
  }

  private sendMessage(message: JsonRpcMessage): void {
    if (this.closed || this.socket.destroyed) {
      return;
    }

    this.socket.write(`${serializeResponse(message)}\n`);
  }
}

function parseToolCall(message: { params?: unknown; method: string }): { tool: string; taskId?: string } | null {
  if (message.method !== 'tools/call' || !isRecord(message.params) || typeof message.params.name !== 'string') {
    return null;
  }

  return {
    tool: message.params.name,
    taskId: readTaskId(message.params.arguments),
  };
}

function readTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readString(value.taskId) ?? readString(value.task_id);
}

function readPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function inferAppName(pid?: number): string | undefined {
  return typeof pid === 'number' ? `app-${pid}` : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
