import { FilesystemBlobStore, MeshSuiClient, RegistryClient, TaskClient } from '@hivemind-os/collective-core';
import { TaskStatus, type AgentCard, type NetworkConfig } from '@hivemind-os/collective-types';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { ECHO_CAPABILITY_NAME } from './agent-a.js';
import { formatMistAsSui, waitForCondition } from './setup.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DISCOVERY_TIMEOUT_MS = 30_000;
const TASK_TIMEOUT_MS = 30_000;

export interface ExecutionSummary {
  provider: AgentCard;
  input: string;
  inputBlobId: string;
  outputBlobId: string;
  priceMist: bigint;
  taskId: string;
  balancesBeforeRelease: {
    requester: bigint;
    provider: bigint;
  };
  balancesAfterRelease: {
    requester: bigint;
    provider: bigint;
  };
}

export async function discoverAndExecute(params: {
  networkConfig: NetworkConfig;
  keypair: Ed25519Keypair;
  blobStore: FilesystemBlobStore;
  input?: string;
  log?: (message: string) => void;
}): Promise<ExecutionSummary> {
  const input = params.input ?? 'Hello from Agent B!';
  const requesterAddress = params.keypair.getPublicKey().toSuiAddress();
  const suiClient = new MeshSuiClient(params.networkConfig);
  const registryClient = new RegistryClient(suiClient, params.networkConfig);
  const taskClient = new TaskClient(suiClient, params.networkConfig);

  const provider = await waitForCondition(async () => {
    const matches = await registryClient.discoverByCapability(ECHO_CAPABILITY_NAME, 10);
    return matches.at(0);
  }, DISCOVERY_TIMEOUT_MS, 'Agent B could not discover an echo provider');

  const pricedCapability = provider.capabilities.find(
    (capability) => capability.name.toLowerCase() === ECHO_CAPABILITY_NAME,
  );
  if (!pricedCapability) {
    throw new Error('The discovered provider did not expose an echo capability price.');
  }

  const priceMist = pricedCapability.pricing.amount;
  params.log?.(
    `🔎 Agent B discovered ${provider.name} (${provider.owner}) offering echo for ${formatMistAsSui(priceMist)} SUI.`,
  );

  const { blobId: inputBlobId } = await params.blobStore.store(encoder.encode(input));
  const { taskId } = await taskClient.postTask({
    capability: ECHO_CAPABILITY_NAME,
    category: 'general',
    inputBlobId,
    priceMist,
    disputeWindowMs: 60_000,
    expiryHours: 1,
    keypair: params.keypair,
  });
  params.log?.(`📮 Agent B posted task ${taskId} with ${formatMistAsSui(priceMist)} SUI escrow.`);

  await waitForCondition(async () => {
    const task = await taskClient.getTask(taskId);
    return task?.status === TaskStatus.ACCEPTED ? task : undefined;
  }, TASK_TIMEOUT_MS, `Task ${taskId} was never accepted`);
  params.log?.(`👀 Agent B observed task ${taskId} move to ACCEPTED.`);

  const completedTask = await waitForCondition(async () => {
    const task = await taskClient.getTask(taskId);
    return task?.status === TaskStatus.COMPLETED ? task : undefined;
  }, TASK_TIMEOUT_MS, `Task ${taskId} was never completed`);

  const resultBlobId = completedTask.resultBlobId;
  if (!resultBlobId) {
    throw new Error(`Task ${taskId} completed without a result blob.`);
  }

  const resultBytes = await params.blobStore.fetch(resultBlobId);
  if (!resultBytes) {
    throw new Error(`Result blob ${resultBlobId} could not be read from the shared blob store.`);
  }

  const result = JSON.parse(decoder.decode(resultBytes)) as {
    capability?: string;
    echo?: string;
    taskId?: string;
  };
  if (result.echo !== input || result.capability !== ECHO_CAPABILITY_NAME || result.taskId !== taskId) {
    throw new Error(`Agent B received an unexpected result payload: ${JSON.stringify(result)}.`);
  }
  params.log?.(`🔍 Agent B verified result blob ${resultBlobId}: "${result.echo}".`);

  const balancesBeforeRelease = {
    requester: await suiClient.getBalance(requesterAddress),
    provider: await suiClient.getBalance(provider.owner),
  };

  await taskClient.releasePayment({
    taskId,
    keypair: params.keypair,
  });

  await waitForCondition(async () => {
    const task = await taskClient.getTask(taskId);
    return task?.status === TaskStatus.RELEASED ? task : undefined;
  }, TASK_TIMEOUT_MS, `Task ${taskId} payment was never released`);

  const balancesAfterRelease = {
    requester: await suiClient.getBalance(requesterAddress),
    provider: await suiClient.getBalance(provider.owner),
  };
  params.log?.(
    `💸 Agent B released payment. Agent A balance changed by +${formatMistAsSui(balancesAfterRelease.provider - balancesBeforeRelease.provider)} SUI.`,
  );

  return {
    provider,
    input,
    inputBlobId,
    outputBlobId: resultBlobId,
    priceMist,
    taskId,
    balancesBeforeRelease,
    balancesAfterRelease,
  };
}
