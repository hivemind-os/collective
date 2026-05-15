import { randomUUID } from 'node:crypto';

import { PaymentRail, type DID } from '@agentic-mesh/types';

import type { AuthProvider } from '../auth/types.js';
import { parseDID, verify } from '../identity/index.js';
import type { X402Client } from '../x402/client.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TIMEOUT_MS = 30_000;

interface RelayChallenge {
  rail?: PaymentRail;
  paymentAddress?: string;
  amount?: string;
  currency?: string;
  network?: string;
  relayFee?: string;
  expiresAt?: number;
  nonce?: string;
  asset?: string;
  extra?: Record<string, string>;
}

interface RelayErrorPayload {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

interface RelaySuiPaymentProof {
  rail: PaymentRail.SUI_TRANSFER;
  payerDid: DID;
  payerAddress: string;
  paymentAddress: string;
  amount: string;
  currency: string;
  network: string;
  nonce: string;
  expiresAt: number;
  signature: string;
}

export class RelayConsumerClient {
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(
    private readonly x402Client: X402Client | null,
    private readonly identity: AuthProvider,
    private readonly config: { relayUrl: string },
  ) {}

  async executeSync(request: {
    providerDid: string;
    capability: string;
    input: unknown;
    paymentRail: PaymentRail;
    timeoutMs?: number;
  }): Promise<{
    result: unknown;
    paymentReceipt?: string;
    latencyMs: number;
    taskId?: string;
    providerDid?: string;
  }> {
    const startedAt = Date.now();
    const response = await this.executeWithPayment(request, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return {
      result: response.result,
      paymentReceipt: response.paymentReceipt,
      latencyMs: Date.now() - startedAt,
      taskId: response.taskId,
      providerDid: response.providerDid,
    };
  }

  async executeSyncStreaming(request: {
    providerDid: string;
    capability: string;
    input: unknown;
    paymentRail: PaymentRail;
    onChunk: (chunk: string) => void;
    onProgress: (progress: number, message?: string) => void;
    timeoutMs?: number;
  }): Promise<{ result: unknown; paymentReceipt?: string }> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const initialResponse = await this.sendExecuteRequest({
      providerDid: request.providerDid,
      capability: request.capability,
      input: request.input,
      paymentRail: request.paymentRail,
      stream: true,
      timeoutMs,
    });

    const challenge = this.requirePaymentChallenge(initialResponse, request.paymentRail);
    const paymentHeader = await this.createPaymentHeader(challenge, request.paymentRail);
    const paidResponse = await this.sendExecuteRequest({
      providerDid: request.providerDid,
      capability: request.capability,
      input: request.input,
      paymentRail: request.paymentRail,
      paymentSignature: paymentHeader,
      paymentNonce: challenge.nonce,
      stream: true,
      timeoutMs,
    });

    if (!paidResponse.response.ok) {
      throw await toRelayError(paidResponse.response);
    }

    const stream = paidResponse.response.body;
    if (!stream) {
      throw new Error('Relay streaming response did not include a body.');
    }

    const reader = stream.getReader();
    let buffer = '';
    let result: unknown;
    let paymentReceipt = paidResponse.response.headers.get('payment-response') ?? undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes('\n\n')) {
        const separator = buffer.indexOf('\n\n');
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) {
          continue;
        }

        const eventData = isRecord(parsed.data) ? parsed.data : {};
        switch (parsed.event) {
          case 'progress':
            request.onProgress(Number(eventData.progress ?? 0), asOptionalString(eventData.message));
            break;
          case 'chunk':
            request.onChunk(String(eventData.data ?? ''));
            break;
          case 'result':
            result = eventData.result;
            paymentReceipt = asOptionalString(eventData.paymentReceipt) ?? paymentReceipt;
            break;
          case 'error':
            throw new Error(String(eventData.message ?? 'Relay streaming task failed.'));
        }
      }
    }

    if (result === undefined) {
      throw new Error('Relay streaming task completed without a final result event.');
    }

    return { result, paymentReceipt };
  }

  private async executeWithPayment(
    request: {
      providerDid: string;
      capability: string;
      input: unknown;
      paymentRail: PaymentRail;
    },
    timeoutMs: number,
  ): Promise<{ result: unknown; paymentReceipt?: string; taskId?: string; providerDid?: string }> {
    const initialResponse = await this.sendExecuteRequest({
      providerDid: request.providerDid,
      capability: request.capability,
      input: request.input,
      paymentRail: request.paymentRail,
      timeoutMs,
    });

    if (initialResponse.response.ok) {
      return {
        result: initialResponse.body,
        paymentReceipt: initialResponse.response.headers.get('payment-response') ?? undefined,
        taskId: initialResponse.response.headers.get('x-mesh-response-id') ?? undefined,
        providerDid: initialResponse.response.headers.get('x-mesh-provider') ?? undefined,
      };
    }

    if (initialResponse.response.status !== 402) {
      throw await toRelayError(initialResponse.response);
    }

    const challenge = this.requirePaymentChallenge(initialResponse, request.paymentRail);
    const signedPayment = await this.createPaymentHeader(challenge, request.paymentRail);
    const paidResponse = await this.sendExecuteRequest({
      providerDid: request.providerDid,
      capability: request.capability,
      input: request.input,
      paymentRail: request.paymentRail,
      paymentSignature: signedPayment,
      paymentNonce: challenge.nonce,
      timeoutMs,
    });

    if (!paidResponse.response.ok) {
      throw await toRelayError(paidResponse.response);
    }

    return {
      result: paidResponse.body,
      paymentReceipt: paidResponse.response.headers.get('payment-response') ?? undefined,
      taskId: paidResponse.response.headers.get('x-mesh-response-id') ?? undefined,
      providerDid: paidResponse.response.headers.get('x-mesh-provider') ?? undefined,
    };
  }

  private async sendExecuteRequest(params: {
    providerDid: string;
    capability: string;
    input: unknown;
    paymentRail: PaymentRail;
    paymentSignature?: string;
    paymentNonce?: string;
    stream?: boolean;
    timeoutMs: number;
  }): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const response = await fetch(buildExecuteUrl(this.config.relayUrl, params.providerDid, params.capability, params.stream), {
        method: 'POST',
        headers: {
          accept: params.stream ? 'text/event-stream' : 'application/json',
          'content-type': 'application/json',
          'x-mesh-request-id': randomUUID(),
          'x-mesh-requester': this.identity.getDID(),
          'x-mesh-target-provider': params.providerDid,
          'x-mesh-session-id': this.sessionId,
          'x-mesh-sequence': String(this.nextSequence()),
          'x-mesh-payment-rail': params.paymentRail,
          ...(params.paymentSignature ? { 'payment-signature': params.paymentSignature } : {}),
          ...(params.paymentNonce ? { 'x-mesh-payment-nonce': params.paymentNonce } : {}),
        },
        body: JSON.stringify(params.input),
        signal: controller.signal,
      });

      const body = params.stream && response.ok
        ? undefined
        : await parseResponseBody(response.clone());
      return { response, body };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Relay request timed out.');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requirePaymentChallenge(
    response: { response: Response; body: unknown },
    paymentRail: PaymentRail,
  ): Required<RelayChallenge> {
    const payload = isRecord(response.body) && isRecord(response.body.payment)
      ? (response.body.payment as RelayChallenge)
      : isRecord(response.body) && isRecord(response.body.paymentRequest)
        ? (response.body.paymentRequest as RelayChallenge)
        : ({} as RelayChallenge);

    const challenge: RelayChallenge = {
      rail: (payload.rail as PaymentRail | undefined) ?? paymentRail,
      paymentAddress: asOptionalString(payload.paymentAddress),
      amount: asOptionalString(payload.amount),
      currency: asOptionalString(payload.currency),
      network: asOptionalString(payload.network),
      relayFee: asOptionalString(payload.relayFee),
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : Number(payload.expiresAt),
      nonce: asOptionalString(payload.nonce),
      asset: asOptionalString(payload.asset),
      extra: isRecord(payload.extra)
        ? Object.fromEntries(Object.entries(payload.extra).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
    };

    if (
      !challenge.rail ||
      !challenge.paymentAddress ||
      !challenge.amount ||
      !challenge.currency ||
      !challenge.network ||
      !challenge.nonce ||
      !Number.isFinite(challenge.expiresAt)
    ) {
      throw new Error('Relay 402 response did not include a supported payment challenge.');
    }

    return challenge as Required<RelayChallenge>;
  }

  private async createPaymentHeader(challenge: Required<RelayChallenge>, rail: PaymentRail): Promise<string> {
    switch (rail) {
      case PaymentRail.X402_BASE: {
        if (!this.x402Client) {
          throw new Error('x402 payment was requested but no x402 client is configured.');
        }

        const paymentRequest = this.x402Client.parse402Response(
          challenge.extra['payment-required'] ? { 'payment-required': challenge.extra['payment-required'] } : {},
          { payment: challenge },
        );
        return this.x402Client.createPaymentHeader(paymentRequest);
      }
      case PaymentRail.SUI_TRANSFER:
      case PaymentRail.SUI_ESCROW:
        return encodeRelaySuiPaymentProof(
          await createRelaySuiPaymentProof(this.identity, {
            paymentAddress: challenge.paymentAddress,
            amount: challenge.amount,
            currency: challenge.currency,
            network: challenge.network,
            nonce: challenge.nonce,
            expiresAt: challenge.expiresAt,
          }),
        );
      default:
        throw new Error(`Unsupported relay payment rail: ${rail}`);
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

export async function createRelaySuiPaymentProof(
  identity: AuthProvider,
  request: {
    paymentAddress: string;
    amount: string;
    currency: string;
    network: string;
    nonce: string;
    expiresAt: number;
  },
): Promise<RelaySuiPaymentProof> {
  const signer = identity.toSuiSigner();
  const payerDid = identity.getDID() as DID;
  const payerAddress = await identity.getAddress();
  const payload = createRelaySuiPayload({
    payerDid,
    payerAddress,
    paymentAddress: request.paymentAddress,
    amount: request.amount,
    currency: request.currency,
    network: request.network,
    nonce: request.nonce,
    expiresAt: request.expiresAt,
  });
  const signature = Buffer.from(await signer.sign(encoder.encode(payload))).toString('hex');

  return {
    rail: PaymentRail.SUI_TRANSFER,
    payerDid,
    payerAddress,
    paymentAddress: request.paymentAddress,
    amount: request.amount,
    currency: request.currency,
    network: request.network,
    nonce: request.nonce,
    expiresAt: request.expiresAt,
    signature,
  };
}

export function encodeRelaySuiPaymentProof(proof: RelaySuiPaymentProof): string {
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64');
}

export function decodeRelaySuiPaymentProof(header: string): RelaySuiPaymentProof {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as RelaySuiPaymentProof;
}

export function verifyRelaySuiPaymentProof(proof: RelaySuiPaymentProof): boolean {
  const signature = Buffer.from(proof.signature, 'hex');
  const publicKey = parseDID(proof.payerDid).publicKey;

  return verify(
    encoder.encode(
      createRelaySuiPayload({
        payerDid: proof.payerDid,
        payerAddress: proof.payerAddress,
        paymentAddress: proof.paymentAddress,
        amount: proof.amount,
        currency: proof.currency,
        network: proof.network,
        nonce: proof.nonce,
        expiresAt: proof.expiresAt,
      }),
    ),
    signature,
    publicKey,
  );
}

function createRelaySuiPayload(params: {
  payerDid: DID;
  payerAddress: string;
  paymentAddress: string;
  amount: string;
  currency: string;
  network: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    'mesh-sui-payment',
    params.payerDid,
    params.payerAddress,
    params.paymentAddress,
    params.amount,
    params.currency,
    params.network,
    params.nonce,
    String(params.expiresAt),
  ].join('|');
}

function buildExecuteUrl(relayUrl: string, providerDid: string, capability: string, stream?: boolean): string {
  const normalized = relayUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/v1\/ws$/i, '');
  const url = new URL(
    `/mesh/providers/${encodeURIComponent(providerDid)}/capabilities/${encodeURIComponent(capability)}/execute`,
    normalized.endsWith('/') ? normalized : `${normalized}/`,
  );
  if (stream) {
    url.searchParams.set('stream', '1');
  }
  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

async function toRelayError(response: Response): Promise<Error> {
  const body = (await parseResponseBody(response.clone())) as RelayErrorPayload | string;
  if (typeof body === 'string') {
    return new Error(body.trim().length > 0 ? body : `Relay request failed with status ${response.status}.`);
  }

  const message = body.error?.message ?? `Relay request failed with status ${response.status}.`;
  return new Error(message);
}

function parseSseEvent(rawEvent: string): { event: string; data: unknown } | null {
  const lines = rawEvent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const dataLine = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();
  if (!event) {
    return null;
  }

  try {
    return {
      event,
      data: dataLine ? JSON.parse(dataLine) : undefined,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
