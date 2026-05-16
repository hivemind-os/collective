import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage as SdkJsonRpcMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionExpiredError } from '@hivemind-os/collective-core';
import {
  meshToolDefinitions,
  meshToolHandlers,
  registerResourceHandlers,
  type MeshToolContext,
} from '@hivemind-os/collective-mcp-server';
import { PaymentRail, TaskStatus } from '@hivemind-os/collective-types';

import { logAuditEvent } from '../audit.js';
import type { ConnectedApp } from '../ipc/connection-registry.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../ipc/protocol.js';
import { isJsonRpcRequest } from '../ipc/protocol.js';
import type { DaemonState } from '../state.js';
import { McpTaskStore, type McpTaskEntry, type McpTaskStatus } from './task-store.js';

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
  private readonly taskStore = new McpTaskStore();
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
      { name: '@hivemind-os/collective-daemon', version: '0.1.0' },
      {
        capabilities: {
          tools: {},
          tasks: {},
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
    this.taskStore.cleanup();
    await this.server.close();
  }

  /** Expose the low-level MCP Server for sampling requests. */
  get mcpServer(): Server {
    return this.server;
  }

  /** Get the per-session MCP task store. */
  getTaskStore(): McpTaskStore {
    return this.taskStore;
  }

  /** Send a progress notification to the connected client. */
  async sendProgress(progressToken: string | number, progress: number, total?: number, message?: string): Promise<void> {
    await this.server.notification({
      method: 'notifications/progress',
      params: { progressToken, progress, total, message },
    });
  }

  /** Send a task status notification to the connected client. */
  async sendTaskStatusNotification(entry: McpTaskEntry): Promise<void> {
    await this.server.notification({
      method: 'notifications/tasks/status',
      params: {
        taskId: entry.taskId,
        status: entry.status,
        ttl: entry.ttl,
        createdAt: entry.createdAt,
        lastUpdatedAt: entry.lastUpdatedAt,
        ...(entry.pollInterval !== undefined ? { pollInterval: entry.pollInterval } : {}),
        ...(entry.statusMessage !== undefined ? { statusMessage: entry.statusMessage } : {}),
      },
    });
  }

  private registerTools(): void {
    const daemonToolDefs = [
      {
        name: 'collective_balance',
        description: 'Return the daemon wallet SUI balance, address, and DID.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'collective_status',
        description: 'Return daemon identity, uptime, and connected apps.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ];

    const daemonToolHandlers: Record<string, () => Promise<unknown>> = {
      collective_balance: async () => {
        const balanceMist = await this.state.suiClient.getBalance(this.state.address);
        return {
          did: this.state.did,
          address: this.state.address,
          balanceMist: balanceMist.toString(),
        };
      },
      collective_status: async () => {
        const status = this.getStatus();
        return {
          ...status,
          connectedApps: status.connectedApps.map((app) => ({ ...app, pid: app.appPid })),
        };
      },
    };

    // Merge: daemon-specific tools + mcp-server tools (skip mcp-server's collective_balance)
    const allToolDefs = [
      ...daemonToolDefs,
      ...meshToolDefinitions.filter((def) => !daemonToolHandlers[def.name]).map((def) => {
        // Annotate collective_execute with task support hint for task-capable clients
        if (def.name === 'collective_execute') {
          return { ...def, execution: { taskSupport: 'optional' as const } };
        }
        return def;
      }),
    ];

    const context = this.toolContext;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allToolDefs,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const meta = request.params._meta as Record<string, unknown> | undefined;
      const progressToken = meta?.progressToken as string | number | undefined;

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
        // For collective_execute: use MCP Tasks (async) only if the client advertises tasks support;
        // otherwise default to blocking (standard CallToolResult) for maximum compatibility.
        if (toolName === 'collective_execute' && this.clientSupportsTasks()) {
          try {
            return await this.handleExecuteAsTask(request.params.arguments as Record<string, unknown>, context, progressToken);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(message);
          }
        }

        try {
          const callContext = { ...context, originAppName: this.getAppName() };
          const result = await meshHandler((request.params.arguments ?? {}) as never, callContext);
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

    // Register MCP task protocol handlers
    this.registerTaskHandlers();

    // Register resource handlers (capabilities, wallet, agent, task resources)
    if (context) {
      registerResourceHandlers(this.server, context);
    }
  }

  /**
   * Check whether the connected client advertises MCP Tasks support.
   * Only VS Code Copilot (as of 2025-11-25 spec) does this; Claude Desktop,
   * ChatGPT, Cursor, Windsurf, and GH Coding Agent do not.
   */
  private clientSupportsTasks(): boolean {
    const caps = this.server.getClientCapabilities();
    return caps?.tasks != null;
  }

  /**
   * Handle collective_execute as an MCP Task: post the on-chain task, return immediately
   * with a task handle, and track completion in the background.
   */
  private async handleExecuteAsTask(
    args: Record<string, unknown>,
    context: MeshToolContext,
    progressToken?: string | number,
  ): Promise<{ task: McpTaskEntry } & Record<string, unknown>> {
    const callContext = { ...context, originAppName: this.getAppName() };
    const executeAsyncHandler = meshToolHandlers['collective_execute_async'];
    if (!executeAsyncHandler) {
      throw new Error('collective_execute_async handler not found');
    }

    // Post the task on chain (calls prepareMeshExecution under the hood)
    const asyncResult = await executeAsyncHandler(args as never, callContext) as {
      task_id: string;
      provider_did: string;
      price_mist: string;
      status: string;
    };

    // Create an MCP task entry tracking this on-chain task
    const mcpTask = this.taskStore.create(asyncResult.task_id, {
      progressToken,
      pollInterval: 2_000,
    });

    // Launch background completion tracker
    void this.trackTaskCompletion(mcpTask.taskId, asyncResult.task_id, callContext, {
      providerDid: asyncResult.provider_did,
      priceMist: BigInt(asyncResult.price_mist),
    });

    // Return MCP CreateTaskResult shape
    return {
      task: mcpTask,
    };
  }

  /**
   * Background loop that polls on-chain task status and sends notifications.
   */
  private async trackTaskCompletion(
    mcpTaskId: string,
    onChainTaskId: string,
    context: MeshToolContext,
    params: { providerDid: string; priceMist: bigint },
  ): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const MAX_DURATION_MS = 300_000; // 5 minutes max
    const startedAt = Date.now();
    let lastChainStatus: number | undefined;

    const entry = this.taskStore.get(mcpTaskId);
    const progressToken = entry?.progressToken;

    try {
      while (true) {
        if (Date.now() - startedAt > MAX_DURATION_MS) {
          this.taskStore.update(mcpTaskId, 'failed', { statusMessage: 'Timed out waiting for provider' });
          await this.sendTaskStatusNotification(this.taskStore.get(mcpTaskId)!);
          return;
        }

        const task = await context.taskClient.getTask(onChainTaskId);
        if (!task) {
          this.taskStore.update(mcpTaskId, 'failed', { statusMessage: 'Task not found on chain' });
          await this.sendTaskStatusNotification(this.taskStore.get(mcpTaskId)!);
          return;
        }

        // Send progress notifications on state transitions
        if (task.status !== lastChainStatus) {
          lastChainStatus = task.status;
          if (progressToken !== undefined) {
            await this.emitProgressForChainStatus(progressToken, task.status);
          }
        }

        // Check for cancellation by client
        const currentEntry = this.taskStore.get(mcpTaskId);
        if (!currentEntry || currentEntry.status === 'cancelled') {
          return;
        }

        if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.RELEASED) {
          // Fetch result and release payment
          let resultText = '';
          if (task.resultBlobId) {
            const resultBytes = await context.blobStore.fetch(task.resultBlobId);
            if (resultBytes) {
              resultText = new TextDecoder().decode(resultBytes);
            }
          }

          if (task.status === TaskStatus.COMPLETED) {
            await context.taskClient.releasePayment({
              taskId: onChainTaskId,
              keypair: context.keypair,
            });
            context.spendingPolicy.record({
              amountMist: params.priceMist,
              rail: PaymentRail.SUI_ESCROW,
              taskId: onChainTaskId,
              appId: params.providerDid,
              originAppName: context.originAppName,
            });
          }

          const toolResult: CallToolResult = {
            content: [{
              type: 'text',
              text: serialize({
                task_id: onChainTaskId,
                result: resultText,
                provider_did: params.providerDid,
                price_mist: params.priceMist.toString(),
                status: 'RELEASED',
                execution_mode: 'async',
                payment_rail: PaymentRail.SUI_ESCROW,
              }),
            }],
          };

          this.taskStore.update(mcpTaskId, 'completed', { result: toolResult });
          await this.sendTaskStatusNotification(this.taskStore.get(mcpTaskId)!);
          return;
        }

        if (task.status === TaskStatus.CANCELLED || task.status === TaskStatus.DISPUTED) {
          this.taskStore.update(mcpTaskId, 'failed', {
            statusMessage: `Task ended with status ${TaskStatus[task.status]}`,
          });
          await this.sendTaskStatusNotification(this.taskStore.get(mcpTaskId)!);
          return;
        }

        await delay(POLL_INTERVAL_MS);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.taskStore.update(mcpTaskId, 'failed', { statusMessage: message });
      try {
        await this.sendTaskStatusNotification(this.taskStore.get(mcpTaskId)!);
      } catch {
        // notification send may fail if connection closed
      }
    }
  }

  private async emitProgressForChainStatus(progressToken: string | number, chainStatus: number): Promise<void> {
    const stages: Record<number, { progress: number; message: string }> = {
      [TaskStatus.POSTED]: { progress: 0.25, message: 'Escrow posted, waiting for provider' },
      [TaskStatus.ACCEPTED]: { progress: 0.5, message: 'Task accepted by provider' },
      [TaskStatus.COMPLETED]: { progress: 0.9, message: 'Provider completed, verifying result' },
      [TaskStatus.RELEASED]: { progress: 1, message: 'Payment released, task complete' },
    };

    const stage = stages[chainStatus];
    if (stage) {
      try {
        await this.sendProgress(progressToken, stage.progress, 1, stage.message);
      } catch {
        // ignore send failures
      }
    }
  }

  private registerTaskHandlers(): void {
    // tasks/get — return current task status
    this.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
      const entry = this.taskStore.get(request.params.taskId);
      if (!entry) {
        throw new Error(`Task ${request.params.taskId} not found`);
      }
      return toTaskResult(entry);
    });

    // tasks/result — return the completed result
    this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
      const entry = this.taskStore.get(request.params.taskId);
      if (!entry) {
        throw new Error(`Task ${request.params.taskId} not found`);
      }
      if (entry.status !== 'completed' || !entry.result) {
        throw new Error(`Task ${request.params.taskId} is not yet completed (status: ${entry.status})`);
      }
      return entry.result;
    });

    // tasks/list — return all tasks for this session
    this.server.setRequestHandler(ListTasksRequestSchema, async () => {
      const tasks = this.taskStore.list().map((entry) => toTaskResult(entry));
      return { tasks };
    });

    // tasks/cancel — cancel a task, trigger on-chain cancel if possible
    this.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
      const entry = this.taskStore.get(request.params.taskId);
      if (!entry) {
        throw new Error(`Task ${request.params.taskId} not found`);
      }

      if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') {
        return toTaskResult(entry);
      }

      // Attempt on-chain cancellation
      if (this.toolContext) {
        try {
          const chainTask = await this.toolContext.taskClient.getTask(entry.onChainTaskId);
          if (chainTask) {
            if (chainTask.status === TaskStatus.POSTED) {
              await this.toolContext.taskClient.cancelTask({
                taskId: entry.onChainTaskId,
                keypair: this.toolContext.keypair,
              });
            } else if (chainTask.status === TaskStatus.ACCEPTED) {
              await this.toolContext.taskClient.disputeTask({
                taskId: entry.onChainTaskId,
                keypair: this.toolContext.keypair,
              });
            }
          }
        } catch {
          // Chain cancellation is best-effort
        }
      }

      const cancelled = this.taskStore.cancel(request.params.taskId);
      return toTaskResult(cancelled ?? entry);
    });
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

function toTaskResult(entry: McpTaskEntry): {
  taskId: string;
  status: McpTaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
} {
  return {
    taskId: entry.taskId,
    status: entry.status,
    ttl: entry.ttl,
    createdAt: entry.createdAt,
    lastUpdatedAt: entry.lastUpdatedAt,
    ...(entry.pollInterval !== undefined ? { pollInterval: entry.pollInterval } : {}),
    ...(entry.statusMessage !== undefined ? { statusMessage: entry.statusMessage } : {}),
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

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
