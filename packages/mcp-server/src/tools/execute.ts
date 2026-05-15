import { PaymentRail, TaskStatus, type AgentCard, type Capability, type Task } from '@agentic-mesh/types';
import { PaymentRailSelector, RelayConsumerClient, type SelectedPaymentRail } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';
import { resolveProviderCapability } from './discover.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_DISPUTE_WINDOW_MS = 5 * 60_000;
const DEFAULT_EXPIRY_HOURS = 24;

export interface MeshExecuteParams {
  capability: string;
  provider_did?: string;
  input: string;
  max_price_mist?: number;
  timeout_seconds?: number;
  mode?: 'auto' | 'sync' | 'async';
}

export const meshExecuteTool = {
  name: 'mesh_execute',
  description: 'Execute a mesh task and wait for the result',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability name to execute' },
      provider_did: { type: 'string', description: 'Specific provider DID to use' },
      input: { type: 'string', description: 'Task input payload' },
      max_price_mist: { type: 'number', description: 'Maximum spend in MIST' },
      timeout_seconds: { type: 'number', description: 'Polling timeout in seconds (default 120)' },
      mode: { type: 'string', enum: ['auto', 'sync', 'async'], description: 'Execution preference (default auto)' },
    },
    required: ['capability', 'input'],
  },
};

export async function runMeshExecute(
  params: MeshExecuteParams,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  result: string;
  provider_did: string;
  price_mist: string;
  status: string;
  execution_mode: 'sync' | 'async';
  payment_rail: PaymentRail;
  payment_receipt?: string;
  latency_ms?: number;
}> {
  const resolved = await resolveProviderCapability(params.capability, context, params.provider_did);
  const priceMist = resolved.capability.pricing.amount;
  const maxPrice = toOptionalBigInt(params.max_price_mist);

  if (maxPrice !== undefined && priceMist > maxPrice) {
    throw new Error(`Provider price ${priceMist.toString()} exceeds max_price_mist ${maxPrice.toString()}.`);
  }

  const mode = params.mode ?? 'auto';
  if (mode !== 'async') {
    const relayResult = await tryRelayExecution(params, context, resolved, priceMist);
    if (relayResult) {
      return relayResult;
    }
  }

  const prepared = await prepareAsyncExecution(params, context, resolved, priceMist);
  const task = await waitForTaskCompletion(prepared.taskId, context, params.timeout_seconds);

  if (!task.resultBlobId) {
    throw new Error(`Task ${prepared.taskId} completed without a result blob.`);
  }

  const resultBytes = await context.blobStore.fetch(task.resultBlobId);
  if (!resultBytes) {
    throw new Error(`Result blob ${task.resultBlobId} was not found.`);
  }

  await context.taskClient.releasePayment({
    taskId: prepared.taskId,
    keypair: context.keypair,
  });
  context.spendingPolicy.record({
    amountMist: prepared.priceMist,
    rail: prepared.rail,
    taskId: prepared.taskId,
    appId: prepared.providerDid,
  });

  return {
    task_id: prepared.taskId,
    result: decoder.decode(resultBytes),
    provider_did: prepared.providerDid,
    price_mist: prepared.priceMist.toString(),
    status: TaskStatus[TaskStatus.RELEASED],
    execution_mode: 'async',
    payment_rail: prepared.rail,
  };
}

export async function prepareMeshExecution(
  params: Pick<MeshExecuteParams, 'capability' | 'provider_did' | 'input' | 'max_price_mist'>,
  context: MeshToolContext,
): Promise<{
  taskId: string;
  providerDid: string;
  priceMist: bigint;
  rail: PaymentRail;
}> {
  const resolved = await resolveProviderCapability(params.capability, context, params.provider_did);
  return prepareAsyncExecution(params, context, resolved, resolved.capability.pricing.amount);
}

async function prepareAsyncExecution(
  params: Pick<MeshExecuteParams, 'input' | 'max_price_mist'>,
  context: MeshToolContext,
  resolved: Awaited<ReturnType<typeof resolveProviderCapability>>,
  priceMist: bigint,
): Promise<{
  taskId: string;
  providerDid: string;
  priceMist: bigint;
  rail: PaymentRail;
}> {
  if (resolved.capability.pricing.rail !== PaymentRail.SUI_ESCROW) {
    throw new Error(`Capability ${resolved.capability.name} does not support SUI escrow execution.`);
  }

  approveSpend(context, priceMist, resolved.capability.pricing.rail, resolved.agent.did);

  const { blobId } = await context.blobStore.store(encoder.encode(params.input));
  const posted = await context.taskClient.postTask({
    capability: resolved.capability.name,
    inputBlobId: blobId,
    priceMist,
    disputeWindowMs: DEFAULT_DISPUTE_WINDOW_MS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    keypair: context.keypair,
  });

  return {
    taskId: posted.taskId,
    providerDid: resolved.agent.did,
    priceMist,
    rail: resolved.capability.pricing.rail,
  };
}

async function tryRelayExecution(
  params: MeshExecuteParams,
  context: MeshToolContext,
  resolved: Awaited<ReturnType<typeof resolveProviderCapability>>,
  priceMist: bigint,
) {
  const relayUrl = getRelayUrl(resolved.agent);
  if (!relayUrl || !context.relayAuthProvider) {
    return null;
  }

  try {
    const selector = context.paymentRailSelector ?? new PaymentRailSelector();
    const selectedRail = selector.selectRail({
      executionMode: 'sync',
      consumerHasSuiWallet: Boolean(context.relayAuthProvider),
      consumerHasEvmWallet: Boolean(context.x402Client),
      providerAcceptsSui: providerAcceptsSui(resolved.capability),
      providerAcceptsX402: providerAcceptsX402(resolved.agent, resolved.capability),
      amount: priceMist,
      currency: resolved.capability.pricing.currency,
    });
    const rail = toPaymentRail(selectedRail);

    approveSpend(context, priceMist, rail, resolved.agent.did);

    const client = new RelayConsumerClient(context.x402Client ?? null, context.relayAuthProvider, { relayUrl });
    const response = await client.executeSync({
      providerDid: resolved.agent.did,
      capability: resolved.capability.name,
      input: params.input,
      paymentRail: rail,
      timeoutMs: normalizeTimeoutMs(params.timeout_seconds),
    });

    const taskId = response.taskId ?? `relay-${resolved.agent.did}-${Date.now()}`;
    context.spendingPolicy.record({
      amountMist: priceMist,
      rail,
      taskId,
      appId: resolved.agent.did,
    });

    return {
      task_id: taskId,
      result: stringifyRelayResult(response.result),
      provider_did: response.providerDid ?? resolved.agent.did,
      price_mist: priceMist.toString(),
      status: 'COMPLETED',
      execution_mode: 'sync' as const,
      payment_rail: rail,
      payment_receipt: response.paymentReceipt,
      latency_ms: response.latencyMs,
    };
  } catch (error) {
    if (!shouldFallbackToAsync(error)) {
      throw error;
    }

    context.logger?.warn?.(
      { err: error, providerDid: resolved.agent.did, capability: resolved.capability.name },
      'Relay execution unavailable; falling back to async Sui flow.',
    );
    return null;
  }
}

export async function waitForTaskCompletion(
  taskId: string,
  context: MeshToolContext,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
): Promise<Task> {
  const timeoutMs = normalizeTimeoutMs(timeoutSeconds);
  const startedAt = Date.now();

  while (true) {
    const task = await context.taskClient.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found.`);
    }

    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.RELEASED) {
      return task;
    }

    if (task.status === TaskStatus.CANCELLED || task.status === TaskStatus.DISPUTED) {
      throw new Error(`Task ${taskId} ended with status ${taskStatusLabel(task.status)}.`);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`Timed out waiting for task ${taskId} to complete.`);
    }

    const remainingMs = timeoutMs - elapsedMs;
    await delay(Math.min(remainingMs, 1_000));
  }
}

function approveSpend(context: MeshToolContext, amountMist: bigint, rail: PaymentRail, appId: string): void {
  const decision = context.spendingPolicy.evaluate({
    amountMist,
    rail,
    appId,
  });
  if (!decision.approved) {
    throw new Error(decision.reason ?? 'Spending policy rejected the request.');
  }
}

function getRelayUrl(agent: AgentCard): string | undefined {
  const relayEndpoint = agent.relayEndpoints?.find((endpoint) => !endpoint.modes || endpoint.modes.includes('sync'));
  if (relayEndpoint?.endpoint) {
    return relayEndpoint.endpoint;
  }

  if (agent.endpoint && /^(https?|wss?):\/\//i.test(agent.endpoint)) {
    return agent.endpoint;
  }

  return undefined;
}

function providerAcceptsSui(capability: Capability): boolean {
  return capability.paymentRails?.includes(PaymentRail.SUI_TRANSFER) ?? capability.pricing.rail !== PaymentRail.X402_BASE;
}

function providerAcceptsX402(agent: AgentCard, capability: Capability): boolean {
  return capability.paymentRails?.includes(PaymentRail.X402_BASE) ?? Boolean(getRelayUrl(agent));
}

function toPaymentRail(selectedRail: SelectedPaymentRail): PaymentRail {
  switch (selectedRail) {
    case 'sui-escrow':
      return PaymentRail.SUI_ESCROW;
    case 'sui-transfer':
      return PaymentRail.SUI_TRANSFER;
    case 'x402-base':
      return PaymentRail.X402_BASE;
  }
}

function shouldFallbackToAsync(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /relay request timed out|fetch failed|provider .* is not connected to the relay|provider not found|payment challenge required|relay execution unavailable/i.test(
    error.message,
  );
}

function stringifyRelayResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function normalizeTimeoutMs(timeoutSeconds?: number): number {
  if (typeof timeoutSeconds !== 'number' || Number.isNaN(timeoutSeconds)) {
    return DEFAULT_TIMEOUT_SECONDS * 1_000;
  }

  return Math.max(0, Math.floor(timeoutSeconds * 1_000));
}

function toOptionalBigInt(value?: number): bigint | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  return BigInt(Math.max(0, Math.floor(value)));
}

function taskStatusLabel(status: TaskStatus): string {
  return TaskStatus[status] ?? 'UNKNOWN';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
