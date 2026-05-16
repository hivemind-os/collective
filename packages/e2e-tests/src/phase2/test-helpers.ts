import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Ed25519AuthProvider,
  createDID,
  createRelaySuiPaymentProof,
  encodeRelaySuiPaymentProof,
  generateKeypair,
  sign,
  type SimpleKeypair,
} from '@hivemind-os/collective-core';
import {
  createAuthPayload,
  createRelayServer,
  parseRelayMessage,
  type PaymentChallenge,
  type PaymentVerification,
  type ProviderSession,
  type RelayConfig,
  type RelayServer,
  type TaskRequestMessage,
} from '@hivemind-os/collective-relay';
import { PaymentRail, type DID } from '@hivemind-os/collective-types';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import WebSocket, { type RawData } from 'ws';

import { PortAllocator } from '../harness/index.js';
import { createArtifactDir, waitForCondition } from '../phase1/test-helpers.js';

export interface TestIdentity {
  did: DID;
  simpleKeypair: SimpleKeypair;
  keypair: Ed25519Keypair;
  authProvider: Ed25519AuthProvider;
}

export interface StartedRelay {
  relay: RelayServer;
  httpUrl: string;
  wsUrl: string;
  port: number;
  stop(): Promise<void>;
}

export interface ConnectProviderOptions {
  wsUrl: string;
  identity?: TestIdentity;
  capabilities: string[];
  onTaskRequest?: (message: TaskRequestMessage, provider: TestProviderConnection) => Promise<void> | void;
}

const defaultPortAllocator = new PortAllocator();

export function createTestIdentity(): TestIdentity {
  const simpleKeypair = generateKeypair();
  const keypair = Ed25519Keypair.fromSecretKey(simpleKeypair.secretKey);

  return {
    did: createDID(simpleKeypair.publicKey),
    simpleKeypair,
    keypair,
    authProvider: new Ed25519AuthProvider(keypair),
  };
}

export async function startTestRelay(params: {
  artifactRoot: string;
  name: string;
  port?: number;
  fees?: Partial<RelayConfig['fees']>;
  limits?: Partial<RelayConfig['limits']>;
  verifyPayment?: (paymentHeader: string, challenge: PaymentChallenge) => Promise<PaymentVerification>;
}): Promise<StartedRelay> {
  const port = params.port ?? (await defaultPortAllocator.allocate(1))[0]!;
  const dataDir = await createArtifactDir(params.artifactRoot, `${params.name}-relay`);
  await mkdir(dataDir, { recursive: true });

  const config: RelayConfig = {
    host: '127.0.0.1',
    port,
    identity: {
      keyPath: join(dataDir, 'relay-identity.key'),
    },
    fees: {
      basePercentage: params.fees?.basePercentage ?? 5,
      minimumMist: params.fees?.minimumMist ?? 1n,
    },
    limits: {
      maxConnections: params.limits?.maxConnections ?? 100,
      maxRequestsPerSecond: params.limits?.maxRequestsPerSecond ?? 100,
      taskTimeoutMs: params.limits?.taskTimeoutMs ?? 5_000,
      heartbeatIntervalMs: params.limits?.heartbeatIntervalMs ?? 1_000,
      heartbeatTimeoutMs: params.limits?.heartbeatTimeoutMs ?? 5_000,
      authNonceTtlMs: params.limits?.authNonceTtlMs ?? 60_000,
    },
  };

  const relay = await createRelayServer(config);
  if (params.verifyPayment) {
    relay.paymentGate.verifyPayment = (paymentHeader, challenge) => params.verifyPayment!(paymentHeader, challenge);
  }

  await relay.start();

  return {
    relay,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/v1/ws`,
    stop: async () => {
      await relay.app.close().catch(() => undefined);
      await defaultPortAllocator.release([port]);
    },
  };
}

export class TestProviderConnection {
  readonly receivedTasks: TaskRequestMessage[] = [];

  private outboundSequence = 0;
  private readonly pendingTasks: Array<(task: TaskRequestMessage) => void> = [];
  private closeInfo?: { code: number; reason: string };

  constructor(
    readonly ws: WebSocket,
    readonly identity: TestIdentity,
    readonly capabilities: string[],
    readonly sessionId: string,
    private taskHandler?: (message: TaskRequestMessage, provider: TestProviderConnection) => Promise<void> | void,
  ) {
    ws.on('message', (payload: RawData) => {
      void this.handleMessage(payload);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.closeInfo = {
        code,
        reason: reason.toString(),
      };
    });
  }

  setTaskHandler(handler: ConnectProviderOptions['onTaskRequest']): void {
    this.taskHandler = handler;
  }

  async waitForTask(timeoutMs = 5_000): Promise<TaskRequestMessage> {
    const existing = this.receivedTasks.at(-1);
    if (existing) {
      return existing;
    }

    return new Promise<TaskRequestMessage>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting ${timeoutMs}ms for a relay task request.`));
      }, timeoutMs);

      this.pendingTasks.push((task) => {
        clearTimeout(timeout);
        resolvePromise(task);
      });
    });
  }

  async waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) {
      return this.closeInfo;
    }

    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting ${timeoutMs}ms for provider WebSocket close.`));
      }, timeoutMs);
      this.ws.once('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        resolvePromise({ code, reason: reason.toString() });
      });
    });
  }

  async sendResult(taskId: string, result: unknown, sequence = this.nextSequence()): Promise<void> {
    await this.send({
      type: 'task_result',
      sessionId: this.sessionId,
      taskId,
      sequence,
      result,
    });
  }

  async sendProgress(taskId: string, progress: number, message?: string, sequence = this.nextSequence()): Promise<void> {
    await this.send({
      type: 'task_progress',
      sessionId: this.sessionId,
      taskId,
      sequence,
      progress,
      message,
    });
  }

  async sendChunk(taskId: string, data: string, sequence = this.nextSequence()): Promise<void> {
    await this.send({
      type: 'task_chunk',
      sessionId: this.sessionId,
      taskId,
      sequence,
      data,
    });
  }

  async sendError(taskId: string, error: { code: string; message: string }, sequence = this.nextSequence()): Promise<void> {
    await this.send({
      type: 'task_error',
      sessionId: this.sessionId,
      taskId,
      sequence,
      error,
    });
  }

  async close(code = 1000, reason = 'test complete'): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      this.ws.once('close', () => resolvePromise());
      this.ws.close(code, reason);
    });
  }

  private async handleMessage(payload: RawData): Promise<void> {
    const message = parseRelayMessage(normalizePayload(payload));
    if (!message || message.type !== 'task_request') {
      return;
    }

    this.receivedTasks.push(message);
    const resolver = this.pendingTasks.shift();
    resolver?.(message);
    await this.taskHandler?.(message, this);
  }

  private nextSequence(): number {
    this.outboundSequence += 1;
    return this.outboundSequence;
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Provider WebSocket is not open.');
    }

    await new Promise<void>((resolvePromise, reject) => {
      this.ws.send(JSON.stringify(payload), (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise();
      });
    });
  }
}

export async function connectTestProvider(options: ConnectProviderOptions): Promise<TestProviderConnection> {
  const identity = options.identity ?? createTestIdentity();
  const ws = new WebSocket(options.wsUrl);

  const sessionId = await new Promise<string>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for provider relay authentication.'));
    }, 5_000);

    ws.once('open', () => {
      setTimeout(() => {
        try {
          const nonce = randomUUID();
          const signature = Buffer.from(
            sign(
              new TextEncoder().encode(createAuthPayload({ did: identity.did, nonce, capabilities: options.capabilities })),
              identity.simpleKeypair.secretKey,
            ),
          ).toString('hex');

          ws.send(
            JSON.stringify({
              type: 'auth',
              did: identity.did,
              nonce,
              signature,
              capabilities: options.capabilities,
            }),
          );
        } catch (error) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, 25);
    });

    ws.on('message', (payload: RawData) => {
      const message = parseRelayMessage(normalizePayload(payload));
      if (!message) {
        return;
      }

      if (message.type === 'auth_ok') {
        clearTimeout(timeout);
        resolvePromise(message.sessionId);
      } else if (message.type === 'auth_fail') {
        clearTimeout(timeout);
        reject(new Error(message.reason));
      }
    });

    ws.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  return new TestProviderConnection(ws, identity, options.capabilities, sessionId, options.onTaskRequest);
}

export async function waitForConnectedProviders(httpUrl: string, expectedCount: number): Promise<void> {
  await waitForCondition(async () => {
    const response = await fetch(`${httpUrl}/health`);
    const body = (await response.json()) as { connectedProviders?: number };
    return body.connectedProviders === expectedCount ? body : undefined;
  }, 5_000, `Relay never reached ${expectedCount} connected provider(s).`);
}

export async function readHealth(httpUrl: string): Promise<{
  status: string;
  relayStatus: string;
  connectedProviders: number;
  activeRequests: number;
  totalRequestsServed: number;
}> {
  const response = await fetch(`${httpUrl}/health`);
  return (await response.json()) as {
    status: string;
    relayStatus: string;
    connectedProviders: number;
    activeRequests: number;
    totalRequestsServed: number;
  };
}

export async function buildSuiPaymentHeaders(identity: TestIdentity, challenge: PaymentChallenge): Promise<Record<string, string>> {
  const proof = await createRelaySuiPaymentProof(identity.authProvider, {
    paymentAddress: challenge.paymentAddress,
    amount: challenge.amount,
    currency: challenge.currency,
    network: challenge.network,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  });

  return {
    'payment-signature': encodeRelaySuiPaymentProof(proof),
    'x-mesh-payment-nonce': challenge.nonce,
  };
}

export function createProviderSession(providerDid: DID, capabilities: string[]): ProviderSession {
  return {
    sessionId: randomUUID(),
    providerDid,
    ws: {} as WebSocket,
    capabilities,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    sequenceCounter: 0,
  };
}

export function executeUrl(httpUrl: string, providerDid: DID, capability: string, stream = false): string {
  const url = new URL(
    `/mesh/providers/${encodeURIComponent(providerDid)}/capabilities/${encodeURIComponent(capability)}/execute`,
    `${httpUrl}/`,
  );
  if (stream) {
    url.searchParams.set('stream', '1');
  }
  return url.toString();
}

export async function postRelayExecute(params: {
  httpUrl: string;
  providerDid: DID;
  capability: string;
  requesterDid: DID;
  paymentRail: PaymentRail;
  input: unknown;
  headers?: Record<string, string>;
}): Promise<Response> {
  return fetch(executeUrl(params.httpUrl, params.providerDid, params.capability), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-mesh-requester': params.requesterDid,
      'x-mesh-target-provider': params.providerDid,
      'x-mesh-payment-rail': params.paymentRail,
      ...params.headers,
    },
    body: JSON.stringify(params.input),
  });
}

function normalizePayload(payload: RawData): string | Buffer | ArrayBuffer | Buffer[] {
  if (typeof payload === 'string' || payload instanceof ArrayBuffer || Array.isArray(payload)) {
    return payload;
  }

  return Buffer.from(payload);
}
