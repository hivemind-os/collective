import { PaymentRail, TaskStatus, type Task } from '@agentic-mesh/types';

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
}> {
  const prepared = await prepareMeshExecution(params, context);
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
  const priceMist = resolved.capability.pricing.amount;
  const maxPrice = toOptionalBigInt(params.max_price_mist);

  if (resolved.capability.pricing.rail !== PaymentRail.SUI_ESCROW) {
    throw new Error(`Capability ${resolved.capability.name} does not support SUI escrow execution.`);
  }

  if (maxPrice !== undefined && priceMist > maxPrice) {
    throw new Error(
      `Provider price ${priceMist.toString()} exceeds max_price_mist ${maxPrice.toString()}.`,
    );
  }

  const decision = context.spendingPolicy.evaluate({
    amountMist: priceMist,
    rail: resolved.capability.pricing.rail,
    appId: resolved.agent.did,
  });
  if (!decision.approved) {
    throw new Error(decision.reason ?? 'Spending policy rejected the request.');
  }

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
