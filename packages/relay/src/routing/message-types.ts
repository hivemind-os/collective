import type { DID } from '@hivemind-os/collective-types';

export interface AuthMessage {
  type: 'auth';
  did: DID;
  nonce: string;
  signature: string;
  capabilities: string[];
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  sessionId: string;
}

export interface TaskResultMessage {
  type: 'task_result';
  sessionId: string;
  taskId: string;
  sequence: number;
  result: unknown;
}

export interface TaskProgressMessage {
  type: 'task_progress';
  sessionId: string;
  taskId: string;
  sequence: number;
  progress: number;
  message?: string;
}

export interface TaskChunkMessage {
  type: 'task_chunk';
  sessionId: string;
  taskId: string;
  sequence: number;
  data: string;
}

export interface TaskErrorMessage {
  type: 'task_error';
  sessionId: string;
  taskId: string;
  sequence: number;
  error: {
    code: string;
    message: string;
  };
}

export type ProviderMessage =
  | AuthMessage
  | HeartbeatMessage
  | TaskResultMessage
  | TaskProgressMessage
  | TaskChunkMessage
  | TaskErrorMessage;

export interface AuthOkMessage {
  type: 'auth_ok';
  sessionId: string;
  relayDid: string;
}

export interface AuthFailMessage {
  type: 'auth_fail';
  reason: string;
}

export interface TaskRequestMessage {
  type: 'task_request';
  sessionId: string;
  taskId: string;
  capability: string;
  input: unknown;
  requesterDid: DID;
  sequence: number;
}

export interface HeartbeatAckMessage {
  type: 'heartbeat_ack';
}

export type RelayMessage = AuthOkMessage | AuthFailMessage | TaskRequestMessage | HeartbeatAckMessage;

export interface TaskRequest {
  requesterDid: DID;
  capability: string;
  input: unknown;
  providerDid?: DID;
  taskId?: string;
  timeoutMs?: number;
}

export interface TaskResponse {
  taskId: string;
  providerDid: DID;
  sequence: number;
  result: unknown;
}

export type TaskStreamEvent =
  | { type: 'progress'; taskId: string; sequence: number; progress: number; message?: string }
  | { type: 'chunk'; taskId: string; sequence: number; data: string }
  | { type: 'result'; taskId: string; sequence: number; result: unknown };

export type ProviderTaskMessage = Exclude<ProviderMessage, AuthMessage | HeartbeatMessage>;

export function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase();
}

export function createAuthPayload(message: Pick<AuthMessage, 'did' | 'nonce' | 'capabilities'>): string {
  const capabilities = [...new Set(message.capabilities.map(normalizeCapability))].sort().join(',');
  return `mesh-relay-auth|${message.did}|${message.nonce}|${capabilities}`;
}

export function serializeRelayMessage(message: RelayMessage): string {
  return JSON.stringify(message);
}

export function parseProviderMessage(payload: string | Buffer | ArrayBuffer | Buffer[]): ProviderMessage | null {
  const raw =
    typeof payload === 'string'
      ? payload
      : payload instanceof ArrayBuffer
        ? Buffer.from(payload).toString('utf8')
        : Array.isArray(payload)
          ? Buffer.concat(payload).toString('utf8')
          : payload.toString('utf8');

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return null;
    }

    switch (parsed.type) {
      case 'auth':
        return typeof parsed.did === 'string' &&
          typeof parsed.nonce === 'string' &&
          typeof parsed.signature === 'string' &&
          Array.isArray(parsed.capabilities) &&
          parsed.capabilities.every((entry) => typeof entry === 'string')
          ? ({
              type: 'auth',
              did: parsed.did as DID,
              nonce: parsed.nonce,
              signature: parsed.signature,
              capabilities: parsed.capabilities,
            } satisfies AuthMessage)
          : null;
      case 'heartbeat':
        return typeof parsed.sessionId === 'string' ? { type: 'heartbeat', sessionId: parsed.sessionId } : null;
      case 'task_result':
        return typeof parsed.sessionId === 'string' && typeof parsed.taskId === 'string' && isPositiveInteger(parsed.sequence)
          ? { type: 'task_result', sessionId: parsed.sessionId, taskId: parsed.taskId, sequence: parsed.sequence, result: parsed.result }
          : null;
      case 'task_progress':
        return typeof parsed.sessionId === 'string' &&
          typeof parsed.taskId === 'string' &&
          isPositiveInteger(parsed.sequence) &&
          isValidProgress(parsed.progress) &&
          (parsed.message === undefined || typeof parsed.message === 'string')
          ? {
              type: 'task_progress',
              sessionId: parsed.sessionId,
              taskId: parsed.taskId,
              sequence: parsed.sequence,
              progress: parsed.progress,
              message: parsed.message,
            }
          : null;
      case 'task_chunk':
        return typeof parsed.sessionId === 'string' &&
          typeof parsed.taskId === 'string' &&
          isPositiveInteger(parsed.sequence) &&
          typeof parsed.data === 'string'
          ? { type: 'task_chunk', sessionId: parsed.sessionId, taskId: parsed.taskId, sequence: parsed.sequence, data: parsed.data }
          : null;
      case 'task_error':
        return typeof parsed.sessionId === 'string' &&
          typeof parsed.taskId === 'string' &&
          isPositiveInteger(parsed.sequence) &&
          isRecord(parsed.error) &&
          typeof parsed.error.code === 'string' &&
          typeof parsed.error.message === 'string'
          ? {
              type: 'task_error',
              sessionId: parsed.sessionId,
              taskId: parsed.taskId,
              sequence: parsed.sequence,
              error: {
                code: parsed.error.code,
                message: parsed.error.message,
              },
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function parseRelayMessage(payload: string | Buffer | ArrayBuffer | Buffer[]): RelayMessage | null {
  const raw =
    typeof payload === 'string'
      ? payload
      : payload instanceof ArrayBuffer
        ? Buffer.from(payload).toString('utf8')
        : Array.isArray(payload)
          ? Buffer.concat(payload).toString('utf8')
          : payload.toString('utf8');

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return null;
    }

    switch (parsed.type) {
      case 'auth_ok':
        return typeof parsed.sessionId === 'string' && typeof parsed.relayDid === 'string'
          ? { type: 'auth_ok', sessionId: parsed.sessionId, relayDid: parsed.relayDid }
          : null;
      case 'auth_fail':
        return typeof parsed.reason === 'string' ? { type: 'auth_fail', reason: parsed.reason } : null;
      case 'heartbeat_ack':
        return { type: 'heartbeat_ack' };
      case 'task_request':
        return typeof parsed.sessionId === 'string' &&
          typeof parsed.taskId === 'string' &&
          typeof parsed.capability === 'string' &&
          typeof parsed.requesterDid === 'string' &&
          isPositiveInteger(parsed.sequence)
          ? {
              type: 'task_request',
              sessionId: parsed.sessionId,
              taskId: parsed.taskId,
              capability: parsed.capability,
              input: parsed.input,
              requesterDid: parsed.requesterDid as DID,
              sequence: parsed.sequence,
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidProgress(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
