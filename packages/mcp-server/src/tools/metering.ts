import { decodeMeteredResult, getMeteredResultUnits, parseMeteredResultEnvelope, ResultVerifier } from '@hivemind-os/collective-core';
import { PaymentRail, PaymentScheme, TaskStatus } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';
import { fetchMeshBlob, hexToBytes, supportsEncryptedBlobs } from '../encryption.js';
import { resolveProviderCapability } from './discover.js';
import { waitForTaskCompletion } from './execute.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_DISPUTE_WINDOW_MS = 5 * 60_000;
const DEFAULT_EXPIRY_HOURS = 24;

export interface MeshMeteredExecuteParams {
  capability: string;
  provider_did?: string;
  input: string;
  max_price_mist: number;
  unit_price_mist: number;
  timeout_seconds?: number;
}

export interface MeshVerifyResultParams {
  task_id: string;
}

export const meshMeteredExecuteTool = {
  name: 'collective_metered_execute',
  description: 'Execute a metered mesh task with capped escrow and result verification',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability name to execute' },
      provider_did: { type: 'string', description: 'Specific provider DID to use' },
      input: { type: 'string', description: 'Task input payload' },
      max_price_mist: { type: 'number', description: 'Maximum escrow in MIST' },
      unit_price_mist: { type: 'number', description: 'Price per metered unit in MIST' },
      timeout_seconds: { type: 'number', description: 'Polling timeout in seconds (default 120)' },
    },
    required: ['capability', 'input', 'max_price_mist', 'unit_price_mist'],
  },
};

export const meshVerifyResultTool = {
  name: 'collective_verify_result',
  description: 'Verify a metered task result blob against its on-chain hash chain root',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task object id' },
    },
    required: ['task_id'],
  },
};

export async function runMeshMeteredExecute(
  params: MeshMeteredExecuteParams,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  provider_did: string;
  result: string;
  status: string;
  payment_rail: PaymentRail;
  payment_scheme: PaymentScheme.UPTO;
  max_price_mist: string;
  actual_price_mist: string;
  unit_price_mist: string;
  metered_units: number;
  verification_hash: string;
  verified: boolean;
}> {
  const resolved = await resolveProviderCapability(params.capability, context, params.provider_did);
  if (resolved.capability.pricing.rail !== PaymentRail.SUI_ESCROW) {
    throw new Error(`Capability ${resolved.capability.name} does not support SUI escrow execution.`);
  }

  const maxPriceMist = toRequiredBigInt(params.max_price_mist, 'max_price_mist');
  const unitPriceMist = toRequiredBigInt(params.unit_price_mist, 'unit_price_mist');
  const spendingDecision = context.spendingPolicy.evaluate({
    amountMist: maxPriceMist,
    rail: PaymentRail.SUI_ESCROW,
    appId: resolved.agent.did,
    originAppName: context.originAppName,
  });
  if (!spendingDecision.approved) {
    throw new Error(spendingDecision.reason ?? 'Spending policy rejected the request.');
  }

  const inputBlob = await storeTaskInput(context, resolved.agent, encoder.encode(params.input));
  const posted = await context.taskClient.postMeteredTask({
    capability: resolved.capability.name,
    category: 'general',
    inputBlobId: inputBlob.blobId,
    agreementHash: `metered:${resolved.capability.name}`,
    maxPriceMist,
    unitPriceMist,
    disputeWindowMs: DEFAULT_DISPUTE_WINDOW_MS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    keypair: context.keypair,
  });
  const task = await waitForTaskCompletion(posted.taskId, context, params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
  const verification = await verifyMeteredTaskResult(task.id, context);

  await context.taskClient.releaseMeteredPayment({
    taskId: task.id,
    keypair: context.keypair,
  });
  context.spendingPolicy.record({
    amountMist: task.price,
    rail: PaymentRail.SUI_ESCROW,
    taskId: task.id,
    appId: resolved.agent.did,
    originAppName: context.originAppName,
  });

  return {
    task_id: task.id,
    provider_did: resolved.agent.did,
    result: verification.result,
    status: TaskStatus[TaskStatus.RELEASED],
    payment_rail: PaymentRail.SUI_ESCROW,
    payment_scheme: PaymentScheme.UPTO,
    max_price_mist: (task.maxPrice ?? maxPriceMist).toString(),
    actual_price_mist: task.price.toString(),
    unit_price_mist: (task.unitPrice ?? unitPriceMist).toString(),
    metered_units: task.meteredUnits ?? verification.metered_units,
    verification_hash: verification.verification_hash,
    verified: verification.verified,
  };
}

export async function runMeshVerifyResult(
  params: MeshVerifyResultParams,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  verified: boolean;
  verification_hash: string;
  metered_units: number;
  result: string;
}> {
  return await verifyMeteredTaskResult(params.task_id, context);
}

async function verifyMeteredTaskResult(
  taskId: string,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  verified: boolean;
  verification_hash: string;
  metered_units: number;
  result: string;
}> {
  const task = await context.taskClient.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }
  if (!task.resultBlobId) {
    throw new Error(`Task ${taskId} does not have a result blob.`);
  }

  const resultBytes = await fetchMeshBlob(context.blobStore, task.resultBlobId);
  if (!resultBytes) {
    throw new Error(`Result blob ${task.resultBlobId} was not found.`);
  }

  const envelope = parseMeteredResultEnvelope(resultBytes);
  if (!envelope) {
    throw new Error(`Result blob ${task.resultBlobId} is not a metered result envelope.`);
  }

  const verifier = new ResultVerifier();
  const verified = verifier.verify(task, envelope.proof, getMeteredResultUnits(envelope));
  return {
    task_id: task.id,
    verified,
    verification_hash: task.verificationHash ?? envelope.proof.root,
    metered_units: task.meteredUnits ?? envelope.proof.unitCount,
    result: decoder.decode(decodeMeteredResult(envelope)),
  };
}

function toRequiredBigInt(value: number, name: string): bigint {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid ${name}.`);
  }

  return BigInt(Math.floor(value));
}

async function storeTaskInput(
  context: MeshToolContext,
  provider: Awaited<ReturnType<typeof resolveProviderCapability>>['agent'],
  input: Uint8Array,
): Promise<{ blobId: string }> {
  const providerEncryptionKey = hexToBytes(provider.encryptionPublicKey) ?? undefined;
  const encryptionEnabled = context.encryption?.enabled ?? supportsEncryptedBlobs(context.blobStore);
  const requireEncryption = context.encryption?.requireEncryption ?? false;

  if (encryptionEnabled && providerEncryptionKey) {
    if (!supportsEncryptedBlobs(context.blobStore)) {
      throw new Error('Encryption is enabled, but the configured blobstore does not support encrypted payloads.');
    }

    return await context.blobStore.storeEncrypted(input, providerEncryptionKey);
  }
  if (requireEncryption) {
    throw new Error(`Provider ${provider.did} does not publish an encryption key.`);
  }
  return await context.blobStore.store(input);
}
