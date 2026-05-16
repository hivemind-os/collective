import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { AuthProvider } from '@hivemind-os/collective-core';
import {
  createAuthPayload,
  parseRelayMessage,
  type TaskRequest,
  type TaskResponse,
} from '@hivemind-os/collective-relay';
import WebSocket from 'ws';

const encoder = new TextEncoder();
const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECONNECT_INTERVAL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface RelayClientConfig {
  relayUrl: string;
  relayDid?: string;
  reconnectIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

interface PendingConnection {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface RelayAuthOkMessage {
  type: 'auth_ok';
  sessionId: string;
  relayDid: string;
}

interface RelayAuthFailMessage {
  type: 'auth_fail';
  reason: string;
}

interface RelayHeartbeatAckMessage {
  type: 'heartbeat_ack';
}

interface RelayTaskRequestMessage {
  type: 'task_request';
  taskId: string;
  capability: string;
  input: unknown;
  requesterDid: TaskRequest['requesterDid'];
  sessionId: string;
  sequence: number;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatAckTimer?: NodeJS.Timeout;
  private pendingConnection: PendingConnection | null = null;
  private taskHandler?: (request: TaskRequest) => Promise<TaskResponse>;
  private registeredCapabilities: string[] = [];
  private reconnectAttempt = 0;
  private outboundSequence = 0;
  private inboundSequence = 0;
  private disconnecting = false;
  private _sessionId: string | null = null;

  constructor(
    private readonly config: RelayClientConfig,
    private readonly identity: AuthProvider,
  ) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this._sessionId !== null;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async connect(capabilities: string[]): Promise<void> {
    this.disconnecting = false;
    this.registeredCapabilities = [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))];
    await this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    this.rejectPendingConnection(new Error('Relay connection closed.'));

    const socket = this.ws;
    this.ws = null;
    this._sessionId = null;
    if (!socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'Client disconnect');
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
      }
    });
  }

  onTaskRequest(handler: (request: TaskRequest) => Promise<TaskResponse>): void {
    this.taskHandler = handler;
  }

  async sendResult(taskId: string, result: unknown): Promise<void> {
    await this.sendTaskMessage({ type: 'task_result', taskId, result });
  }

  async sendProgress(taskId: string, progress: number, message?: string): Promise<void> {
    await this.sendTaskMessage({ type: 'task_progress', taskId, progress, message });
  }

  async sendChunk(taskId: string, data: string): Promise<void> {
    await this.sendTaskMessage({ type: 'task_chunk', taskId, data });
  }

  async sendError(taskId: string, error: { code: string; message: string }): Promise<void> {
    await this.sendTaskMessage({ type: 'task_error', taskId, error });
  }

  private async openConnection(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.pendingConnection) {
      return new Promise<void>((resolve, reject) => {
        const current = this.pendingConnection;
        if (!current) {
          resolve();
          return;
        }

        const originalResolve = current.resolve;
        const originalReject = current.reject;
        current.resolve = () => {
          originalResolve();
          resolve();
        };
        current.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
    }

    const socket = new WebSocket(this.config.relayUrl);
    this.ws = socket;
    this._sessionId = null;
    this.inboundSequence = 0;
    this.outboundSequence = 0;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Relay connection timed out.'));
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      this.pendingConnection = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };

      socket.once('open', () => {
        void this.authenticate(socket).catch((error) => {
          this.rejectPendingConnection(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        });
      });
      socket.once('error', (error) => {
        this.rejectPendingConnection(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    const nonce = randomUUID();
    const signature = Buffer.from(await this.identity.toSuiSigner().sign(encoder.encode(createAuthPayload({
      did: this.identity.getDID() as TaskRequest['requesterDid'],
      nonce,
      capabilities: this.registeredCapabilities,
    })))).toString('hex');

    socket.send(
      JSON.stringify({
        type: 'auth',
        did: this.identity.getDID() as TaskRequest['requesterDid'],
        nonce,
        signature,
        capabilities: this.registeredCapabilities,
      }),
    );

    socket.on('message', (payload) => {
      void this.handleMessage(payload);
    });
    socket.once('close', () => {
      this.handleClose();
    });
    socket.once('error', () => {
      this.handleClose();
    });
  }

  private async handleMessage(payload: WebSocket.RawData): Promise<void> {
    const message = parseMessage(payload);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'auth_ok':
        if (this.config.relayDid && this.config.relayDid !== message.relayDid) {
          this.rejectPendingConnection(new Error(`Relay DID mismatch: expected ${this.config.relayDid}, received ${message.relayDid}.`));
          this.ws?.close(4009, 'Relay DID mismatch');
          return;
        }

        this._sessionId = message.sessionId;
        this.reconnectAttempt = 0;
        this.resolvePendingConnection();
        this.startHeartbeat();
        return;
      case 'auth_fail':
        this.rejectPendingConnection(new Error(message.reason));
        return;
      case 'heartbeat_ack':
        this.clearHeartbeatAckTimer();
        return;
      case 'task_request':
        if (!this._sessionId || message.sessionId !== this._sessionId) {
          return;
        }
        if (message.sequence <= this.inboundSequence) {
          this.ws?.close(4010, 'Out-of-order task request');
          return;
        }

        this.inboundSequence = message.sequence;
        await this.handleTaskRequest(message);
        return;
    }
  }

  private async handleTaskRequest(message: RelayTaskRequestMessage): Promise<void> {
    const handler = this.taskHandler;
    if (!handler) {
      await this.sendError(message.taskId, { code: 'NO_HANDLER', message: 'No relay task handler is registered.' });
      return;
    }

    try {
      const response = await handler({
        requesterDid: message.requesterDid,
        capability: message.capability,
        input: message.input,
        taskId: message.taskId,
        timeoutMs: this.config.heartbeatIntervalMs,
      });
      await this.sendResult(message.taskId, response.result);
    } catch (error) {
      await this.sendError(message.taskId, {
        code: 'TASK_FAILED',
        message: error instanceof Error ? error.message : 'Relay task execution failed.',
      });
    }
  }

  private async sendTaskMessage(message: Record<string, unknown>): Promise<void> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this._sessionId) {
      throw new Error('Relay client is not connected.');
    }

    const payload = JSON.stringify({
      ...message,
      sessionId: this._sessionId,
      sequence: this.nextSequence(),
    });

    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private nextSequence(): number {
    this.outboundSequence += 1;
    return this.outboundSequence;
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    const intervalMs = Math.max(1_000, this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => {
      if (!this._sessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      this.ws.send(JSON.stringify({ type: 'heartbeat', sessionId: this._sessionId }));
      this.clearHeartbeatAckTimer();
      this.heartbeatAckTimer = setTimeout(() => {
        this.ws?.close(4011, 'Heartbeat acknowledgement timed out');
      }, Math.max(5_000, Math.floor(intervalMs / 2)));
    }, intervalMs);
  }

  private handleClose(): void {
    this.clearHeartbeatTimers();
    this._sessionId = null;
    this.rejectPendingConnection(new Error('Relay connection closed.'));
    this.ws = null;

    if (!this.disconnecting) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const baseDelay = this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    const reconnectDelay = Math.min(baseDelay * 2 ** this.reconnectAttempt, MAX_RECONNECT_INTERVAL_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.reconnect().catch(() => {
        this.scheduleReconnect();
      });
    }, reconnectDelay);
  }

  private async reconnect(): Promise<void> {
    await delay(0);
    await this.openConnection();
  }

  private resolvePendingConnection(): void {
    if (!this.pendingConnection) {
      return;
    }

    const pending = this.pendingConnection;
    this.pendingConnection = null;
    clearTimeout(pending.timeout);
    pending.resolve();
  }

  private rejectPendingConnection(error: Error): void {
    if (!this.pendingConnection) {
      return;
    }

    const pending = this.pendingConnection;
    this.pendingConnection = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearHeartbeatAckTimer(): void {
    if (this.heartbeatAckTimer) {
      clearTimeout(this.heartbeatAckTimer);
      this.heartbeatAckTimer = undefined;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.clearHeartbeatAckTimer();
  }
}

function parseMessage(payload: WebSocket.RawData): RelayAuthOkMessage | RelayAuthFailMessage | RelayHeartbeatAckMessage | RelayTaskRequestMessage | null {
  const parsed = parseRelayMessage(
    typeof payload === 'string'
      ? payload
      : payload instanceof ArrayBuffer
        ? payload
        : Array.isArray(payload)
          ? payload
          : Buffer.from(payload),
  );

  if (!parsed) {
    return null;
  }

  switch (parsed.type) {
    case 'auth_ok':
      return parsed;
    case 'auth_fail':
      return parsed;
    case 'heartbeat_ack':
      return parsed;
    case 'task_request':
      return parsed;
    default:
      return null;
  }
}
