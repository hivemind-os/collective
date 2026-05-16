import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  DisputeClient,
  EncryptedBlobStore,
  FilesystemBlobStore,
  MarketplaceClient,
  MeshSuiClient,
  RegistryClient,
  ReputationAnchorClient,
  ReputationScoreCalculator,
  ReputationStore,
  StakingClient,
  TaskClient,
  buildMerkleTree,
  computeSharedSecret,
  verifyMerkleProof,
  decryptFromSender,
  ed25519ToX25519,
  encryptForRecipient,
  generateX25519KeyPair,
  parseEncryptedPayload,
  serializeEncryptedPayload,
} from '@hivemind-os/collective-core';
import { BidStatus, DisputeStatus, TaskStatus, type AgentCard, type DID, type NetworkConfig, type ReputationEvent } from '@hivemind-os/collective-types';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { TestWallet } from '../harness/index.js';
import {
  buildEchoResult,
  createArtifactDir,
  createCapability,
  createNetworkConfig,
  createTestDid,
  decoder,
  defaultDisputeWindowMs,
  defaultPriceMist,
  delay,
  encoder,
  fetchAllEvents,
  parseJson,
  postTaskWithBlobStore,
  requestFromFaucet,
  seedCursorToLatestEvent,
  waitForCondition,
  waitForTaskStatus,
} from '../phase1/test-helpers.js';

export * from '../phase1/test-helpers.js';
export {
  BidStatus,
  DisputeClient,
  DisputeStatus,
  EncryptedBlobStore,
  FilesystemBlobStore,
  MarketplaceClient,
  MeshSuiClient,
  RegistryClient,
  ReputationAnchorClient,
  ReputationScoreCalculator,
  ReputationStore,
  StakingClient,
  TaskClient,
  TaskStatus,
  buildMerkleTree,
  buildEchoResult,
  verifyMerkleProof,
  computeSharedSecret,
  createArtifactDir,
  createCapability,
  createNetworkConfig,
  createTestDid,
  decoder,
  defaultDisputeWindowMs,
  defaultPriceMist,
  delay,
  ed25519ToX25519,
  encoder,
  encryptForRecipient,
  decryptFromSender,
  fetchAllEvents,
  generateX25519KeyPair,
  parseEncryptedPayload,
  parseJson,
  postTaskWithBlobStore,
  requestFromFaucet,
  seedCursorToLatestEvent,
  serializeEncryptedPayload,
  waitForCondition,
  waitForTaskStatus,
};

export interface Phase3ClientBundle {
  sui: MeshSuiClient;
  registry: RegistryClient;
  task: TaskClient;
  staking: StakingClient;
  dispute: DisputeClient;
  marketplace: MarketplaceClient;
  reputationAnchor: ReputationAnchorClient;
}

export function createPhase3Clients(config: NetworkConfig): Phase3ClientBundle {
  const sui = new MeshSuiClient(config);
  return {
    sui,
    registry: new RegistryClient(sui, config),
    task: new TaskClient(sui, config),
    staking: new StakingClient(sui, config),
    dispute: new DisputeClient(sui, config),
    marketplace: new MarketplaceClient(sui, config),
    reputationAnchor: new ReputationAnchorClient(sui, config),
  };
}

export async function createBlobStore(root: string, name: string): Promise<FilesystemBlobStore> {
  return new FilesystemBlobStore(await createArtifactDir(root, name));
}

export async function createReputationDbPath(root: string, name: string): Promise<string> {
  return join(await createArtifactDir(root, `${name}-reputation`), 'reputation.sqlite');
}

export async function registerTestAgent(params: {
  config: NetworkConfig;
  wallet: TestWallet;
  capabilityName?: string;
  name?: string;
  endpoint?: string;
  did?: DID;
  description?: string;
  encryptionPublicKey?: Uint8Array;
}): Promise<{ clients: Phase3ClientBundle; agentCardId: string; did: DID }> {
  const clients = createPhase3Clients(params.config);
  const did = (params.did ?? createTestDid(params.name ?? 'phase3-provider')) as DID;
  const capabilityName = params.capabilityName ?? 'echo';
  const registration = await clients.registry.registerAgent({
    name: params.name ?? 'Phase 3 Agent',
    did,
    description: params.description ?? `Phase 3 test agent for ${capabilityName}`,
    capabilities: [createCapability({ name: capabilityName, amountMist: defaultPriceMist })],
    endpoint: params.endpoint ?? `mesh://agent/${randomUUID()}`,
    encryptionPublicKey: params.encryptionPublicKey,
    keypair: params.wallet.keypair,
  });
  return {
    clients,
    agentCardId: registration.agentCardId,
    did,
  };
}

export async function completeTaskAndClaimWithCard(params: {
  requesterTaskClient: TaskClient;
  providerTaskClient: TaskClient;
  blobStore: FilesystemBlobStore;
  taskId: string;
  inputData: Uint8Array;
  capability?: string;
  providerCardId: string;
  providerKeypair: Ed25519Keypair;
}): Promise<{ resultBlobId: string }> {
  await params.providerTaskClient.acceptTask({ taskId: params.taskId, keypair: params.providerKeypair });
  await waitForTaskStatus(params.requesterTaskClient, params.taskId, TaskStatus.ACCEPTED);

  const result = buildEchoResult(params.taskId, params.capability ?? 'echo', params.inputData);
  const { blobId: resultBlobId } = await params.blobStore.store(result);
  await params.providerTaskClient.completeTask({
    taskId: params.taskId,
    resultBlobId,
    providerCardId: params.providerCardId,
    keypair: params.providerKeypair,
  });
  await waitForTaskStatus(params.requesterTaskClient, params.taskId, TaskStatus.COMPLETED);

  await params.providerTaskClient.claimPayment({
    taskId: params.taskId,
    providerCardId: params.providerCardId,
    keypair: params.providerKeypair,
  });
  await waitForTaskStatus(params.requesterTaskClient, params.taskId, TaskStatus.RELEASED);

  return { resultBlobId };
}

export async function waitForBidStatus(
  marketplaceClient: MarketplaceClient,
  bidId: string,
  status: BidStatus,
  timeoutMs = 20_000,
) {
  return await waitForCondition(async () => {
    const bid = await marketplaceClient.getBid(bidId);
    return bid?.status === status ? bid : undefined;
  }, timeoutMs, `Bid ${bidId} never reached status ${BidStatus[status]}`);
}

export async function waitForDisputeStatus(
  disputeClient: DisputeClient,
  disputeId: string,
  status: DisputeStatus,
  timeoutMs = 20_000,
) {
  return await waitForCondition(async () => {
    const dispute = await disputeClient.getDispute(disputeId);
    return dispute?.status === status ? dispute : undefined;
  }, timeoutMs, `Dispute ${disputeId} never reached status ${DisputeStatus[status]}`);
}

export async function findEventByFields(
  suiClient: MeshSuiClient,
  eventType: string,
  predicate: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  const events = await fetchAllEvents(suiClient, eventType);
  return events
    .map((event) => (typeof event.parsedJson === 'object' && event.parsedJson ? event.parsedJson as Record<string, unknown> : undefined))
    .find((payload) => Boolean(payload) && predicate(payload as Record<string, unknown>));
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export function createReputationEvent(overrides: Partial<ReputationEvent> = {}): ReputationEvent {
  const index = randomUUID();
  return {
    eventId: `event-${index}`,
    type: 'task_completion',
    subject: 'did:mesh:provider',
    author: 'did:mesh:requester',
    taskId: `task-${index}`,
    outcome: 'success',
    capability: 'echo',
    paymentAmount: { amount: defaultPriceMist.toString(), currency: 'MIST' },
    latencyMs: 250,
    timestamp: new Date().toISOString(),
    nonce: `nonce-${index}`,
    signature: `signature-${index}`,
    ...overrides,
  };
}

export function createAgentCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const did = (overrides.did ?? createTestDid('score-agent')) as AgentCard['did'];
  return {
    id: `0x${randomUUID().replace(/-/g, '')}`,
    owner: `0x${randomUUID().replace(/-/g, '').slice(0, 40)}`,
    did,
    name: 'Scored Agent',
    description: 'Synthetic card for score testing',
    capabilities: [createCapability({ name: 'echo', amountMist: defaultPriceMist })],
    endpoint: 'mesh://score-agent',
    active: true,
    version: 1,
    registeredAt: Date.now() - 10_000,
    updatedAt: Date.now() - 5_000,
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
    totalTasksDisputed: 0,
    totalEarningsMist: 0n,
    ...overrides,
  };
}
