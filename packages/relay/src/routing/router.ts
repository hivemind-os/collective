import { randomUUID } from 'node:crypto';

import type { DID } from '@agentic-mesh/types';
import type WebSocket from 'ws';

import type { ProviderTaskMessage, TaskRequest, TaskResponse, TaskStreamEvent, TaskRequestMessage } from './message-types.js';
import { serializeRelayMessage } from './message-types.js';
import { SessionManager } from './session-manager.js';

interface RelayRouterOptions {
  sessionManager: SessionManager;
  taskTimeoutMs: number;
}

interface PendingTask {
  taskId: string;
  sessionId: string;
  onChunk?: (event: TaskStreamEvent) => void;
  resolve: (response: TaskResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RelayRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RelayRouteError';
  }
}

export class RelayRouter {
  private readonly pendingTasks = new Map<string, PendingTask>();

  constructor(private readonly options: RelayRouterOptions) {
    this.options.sessionManager.on('session_removed', (session: { sessionId: string }) => {
      this.rejectSessionTasks(session.sessionId, new RelayRouteError('PROVIDER_DISCONNECTED', 'Provider disconnected.', 503, true));
    });
  }

  async routeTask(request: TaskRequest): Promise<TaskResponse> {
    return this.dispatch(request);
  }

  async routeStreamingTask(request: TaskRequest, onChunk: (chunk: TaskStreamEvent) => void): Promise<TaskResponse> {
    return this.dispatch(request, onChunk);
  }

  async routeMulti(request: TaskRequest, providerDids: DID[]): Promise<TaskResponse[]> {
    return await Promise.all(
      providerDids.map((providerDid, index) => this.dispatch({
        ...request,
        providerDid,
        taskId: request.taskId ? `${request.taskId}-${index + 1}` : undefined,
      })),
    );
  }

  close(): void {
    for (const taskId of [...this.pendingTasks.keys()]) {
      this.completeTask(
        taskId,
        undefined,
        new RelayRouteError('RELAY_SHUTDOWN', 'Relay is shutting down.', 503, true),
      );
    }
  }

  handleProviderMessage(sessionId: string, message: ProviderTaskMessage): void {
    if (message.sessionId !== sessionId) {
      throw new RelayRouteError('SESSION_MISMATCH', 'Relay session id did not match the authenticated connection.', 409);
    }

    if (!this.options.sessionManager.validateIncomingSequence(sessionId, message.sequence)) {
      throw new RelayRouteError('REPLAY_DETECTED', 'Out-of-order relay message rejected.', 409);
    }

    const session = this.options.sessionManager.getSession(sessionId);
    if (!session) {
      throw new RelayRouteError('SESSION_NOT_FOUND', 'Relay session was not found.', 404);
    }

    const pending = this.pendingTasks.get(message.taskId);
    if (!pending || pending.sessionId !== sessionId) {
      return;
    }

    switch (message.type) {
      case 'task_progress':
        this.emitTaskEvent(message.taskId, {
          type: 'progress',
          taskId: message.taskId,
          sequence: message.sequence,
          progress: message.progress,
          message: message.message,
        });
        break;
      case 'task_chunk':
        this.emitTaskEvent(message.taskId, {
          type: 'chunk',
          taskId: message.taskId,
          sequence: message.sequence,
          data: message.data,
        });
        break;
      case 'task_error':
        this.completeTask(
          message.taskId,
          undefined,
          new RelayRouteError(message.error.code, message.error.message, 502, true),
        );
        break;
      case 'task_result':
        if (!this.emitTaskEvent(message.taskId, {
          type: 'result',
          taskId: message.taskId,
          sequence: message.sequence,
          result: message.result,
        })) {
          return;
        }

        this.completeTask(message.taskId, {
          taskId: message.taskId,
          providerDid: session.providerDid,
          sequence: message.sequence,
          result: message.result,
        });
        break;
    }
  }

  private async dispatch(request: TaskRequest, onChunk?: (event: TaskStreamEvent) => void): Promise<TaskResponse> {
    const session = this.findSession(request.capability, request.providerDid);
    const taskId = request.taskId ?? randomUUID();
    const sequence = this.options.sessionManager.nextSequence(session.sessionId);
    const relayMessage: TaskRequestMessage = {
      type: 'task_request',
      sessionId: session.sessionId,
      taskId,
      capability: request.capability,
      input: request.input,
      requesterDid: request.requesterDid,
      sequence,
    };

    const response = new Promise<TaskResponse>((resolve, reject) => {
      const timeoutMs = request.timeoutMs ?? this.options.taskTimeoutMs;
      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new RelayRouteError('TASK_TIMEOUT', `Task ${taskId} timed out.`, 504, true));
      }, timeoutMs);

      this.pendingTasks.set(taskId, {
        taskId,
        sessionId: session.sessionId,
        onChunk,
        resolve,
        reject,
        timer,
      });
    });

    try {
      await sendWebSocketMessage(session.ws, serializeRelayMessage(relayMessage));
      return await response;
    } catch (error) {
      this.completeTask(taskId, undefined, toRouteError(error));
      throw toRouteError(error);
    }
  }

  private emitTaskEvent(taskId: string, event: TaskStreamEvent): boolean {
    const pending = this.pendingTasks.get(taskId);
    if (!pending?.onChunk) {
      return true;
    }

    try {
      pending.onChunk(event);
      return true;
    } catch {
      this.completeTask(
        taskId,
        undefined,
        new RelayRouteError('STREAM_DELIVERY_FAILED', 'Streaming consumer disconnected before relay delivery completed.', 499, true),
      );
      return false;
    }
  }

  private completeTask(taskId: string, response?: TaskResponse, error?: Error): void {
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTasks.delete(taskId);

    if (error) {
      pending.reject(error);
      return;
    }

    if (!response) {
      pending.reject(new RelayRouteError('TASK_FAILED', `Task ${taskId} failed.`, 500));
      return;
    }

    pending.resolve(response);
  }

  private rejectSessionTasks(sessionId: string, error: Error): void {
    for (const [taskId, pending] of this.pendingTasks.entries()) {
      if (pending.sessionId !== sessionId) {
        continue;
      }

      this.completeTask(taskId, undefined, error);
    }
  }

  private findSession(capability: string, providerDid?: DID) {
    const session = this.options.sessionManager.findProvider(capability, providerDid);
    if (!session) {
      throw new RelayRouteError('PROVIDER_NOT_FOUND', `No provider is connected for capability ${capability}.`, 404, true);
    }

    return session;
  }
}

async function sendWebSocketMessage(ws: WebSocket, message: string): Promise<void> {
  if ('readyState' in ws && typeof ws.readyState === 'number' && ws.readyState !== 1) {
    throw new RelayRouteError('PROVIDER_UNAVAILABLE', 'Provider WebSocket is not open.', 503, true);
  }

  await new Promise<void>((resolve, reject) => {
    try {
      (ws as WebSocket & { send: (data: string, callback?: (error?: Error) => void) => void }).send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function toRouteError(error: unknown): RelayRouteError {
  if (error instanceof RelayRouteError) {
    return error;
  }

  return new RelayRouteError('ROUTING_FAILED', error instanceof Error ? error.message : 'Relay routing failed.', 502, true);
}
