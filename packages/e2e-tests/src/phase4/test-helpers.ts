import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  MarketplaceClient,
  MeshSuiClient,
  RegistryClient,
  RelayDiscovery,
  RelayRegistryClient,
  ResultVerifier,
  StakingClient,
  TaskClient,
  UsageMeter,
  createMeteredResultEnvelope,
  getMeteredResultUnits,
  parseMeteredResultEnvelope,
  serializeMeteredResultEnvelope,
  splitIntoMeteringUnits,
  CircuitBreaker,
  FanOutExecutor,
  PerformanceTracker,
  ProviderSelector,
} from '@agentic-mesh/core';
import { AnalyticsEngine, IndexerStore, MeshIndexer, createIndexerGraphQLServer } from '@agentic-mesh/indexer';
import {
  AggregationMode,
  PaymentScheme,
  ProviderSelectionStrategy,
  RelayNodeStatus,
  TaskStatus,
  type DID,
  type NetworkConfig,
} from '@agentic-mesh/types';
import type { TestWallet } from '../harness/index.js';
import { PortAllocator } from '../harness/index.js';
import {
  createArtifactDir,
  createCapability,
  createTestDid,
  defaultDisputeWindowMs,
  defaultExpiryHours,
  defaultPriceMist,
  encoder,
  waitForCondition,
} from '../phase1/test-helpers.js';
import { createBlobStore, findEventByFields, waitForBidStatus } from '../phase3/test-helpers.js';

export * from '../phase1/test-helpers.js';
export { createBlobStore, findEventByFields, waitForBidStatus };
export {
  AggregationMode,
  AnalyticsEngine,
  CircuitBreaker,
  FanOutExecutor,
  IndexerStore,
  MarketplaceClient,
  MeshIndexer,
  MeshSuiClient,
  PaymentScheme,
  PerformanceTracker,
  ProviderSelectionStrategy,
  ProviderSelector,
  RegistryClient,
  RelayDiscovery,
  RelayNodeStatus,
  RelayRegistryClient,
  ResultVerifier,
  StakingClient,
  TaskClient,
  TaskStatus,
  UsageMeter,
  createIndexerGraphQLServer,
  createMeteredResultEnvelope,
  getMeteredResultUnits,
  parseMeteredResultEnvelope,
  serializeMeteredResultEnvelope,
  splitIntoMeteringUnits,
};

const graphqlPortAllocator = new PortAllocator();

export interface Phase4ClientBundle {
  sui: MeshSuiClient;
  registry: RegistryClient;
  task: TaskClient;
  staking: StakingClient;
  marketplace: MarketplaceClient;
  relayRegistry: RelayRegistryClient;
}

export function createPhase4Clients(config: NetworkConfig): Phase4ClientBundle {
  const sui = new MeshSuiClient(config);
  return {
    sui,
    registry: new RegistryClient(sui, config),
    task: new TaskClient(sui, config),
    staking: new StakingClient(sui, config),
    marketplace: new MarketplaceClient(sui, config),
    relayRegistry: new RelayRegistryClient(sui, config),
  };
}

export async function createPhase4DbPath(root: string, name: string, fileName = 'phase4.sqlite'): Promise<string> {
  return join(await createArtifactDir(root, name), fileName);
}

export async function registerPhase4Agent(params: {
  config: NetworkConfig;
  wallet: TestWallet;
  capabilityName?: string;
  priceMist?: bigint;
  name?: string;
  endpoint?: string;
  did?: DID;
  description?: string;
  encryptionPublicKey?: Uint8Array;
}): Promise<{ clients: Phase4ClientBundle; agentCardId: string; did: DID }> {
  const clients = createPhase4Clients(params.config);
  const capabilityName = params.capabilityName ?? 'echo';
  const did = (params.did ?? createTestDid(params.name ?? 'phase4-provider')) as DID;
  const registration = await clients.registry.registerAgent({
    name: params.name ?? 'Phase 4 Agent',
    did,
    description: params.description ?? `Phase 4 test agent for ${capabilityName}`,
    capabilities: [createCapability({ name: capabilityName, amountMist: params.priceMist ?? defaultPriceMist })],
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

export async function postMeteredTaskWithBlobStore(params: {
  taskClient: TaskClient;
  blobStore: Awaited<ReturnType<typeof createBlobStore>>;
  input: string | Uint8Array;
  capability?: string;
  category?: string;
  agreementHash?: string;
  maxPriceMist: bigint;
  unitPriceMist: bigint;
  disputeWindowMs?: number;
  expiryHours?: number;
  keypair: TestWallet['keypair'];
}): Promise<{ taskId: string; inputBlobId: string; inputData: Uint8Array }> {
  const inputData = typeof params.input === 'string' ? encoder.encode(params.input) : params.input;
  const { blobId: inputBlobId } = await params.blobStore.store(inputData);
  const { taskId } = await params.taskClient.postMeteredTask({
    capability: params.capability ?? 'echo',
    category: params.category ?? 'general',
    inputBlobId,
    agreementHash: params.agreementHash,
    maxPriceMist: params.maxPriceMist,
    unitPriceMist: params.unitPriceMist,
    disputeWindowMs: params.disputeWindowMs ?? defaultDisputeWindowMs,
    expiryHours: params.expiryHours ?? defaultExpiryHours,
    keypair: params.keypair,
  });

  return { taskId, inputBlobId, inputData };
}

export function buildMeteredResultArtifacts(params: {
  taskId: string;
  resultData: Uint8Array;
  maxPrice: bigint;
  unitPrice: bigint;
  unitChunkSize?: number;
}): {
  meter: UsageMeter;
  units: Uint8Array[];
  envelopeBytes: Uint8Array;
} {
  const unitChunkSize = params.unitChunkSize ?? 8;
  const units = splitIntoMeteringUnits(params.resultData, unitChunkSize);
  const meter = new UsageMeter({
    taskId: params.taskId,
    maxPrice: params.maxPrice,
    unitPrice: params.unitPrice,
  });

  for (const unit of units) {
    meter.recordUnit(unit);
  }

  const envelopeBytes = serializeMeteredResultEnvelope(
    createMeteredResultEnvelope(params.resultData, meter.getProof(), unitChunkSize),
  );

  return {
    meter,
    units,
    envelopeBytes,
  };
}

export async function waitForIndexedTask(
  store: IndexerStore,
  taskId: string,
  predicate: (task: NonNullable<ReturnType<IndexerStore['getTask']>>) => boolean = () => true,
  timeoutMs = 20_000,
) {
  return await waitForCondition(async () => {
    const task = store.getTask(taskId);
    return task && predicate(task) ? task : undefined;
  }, timeoutMs, `Indexed task ${taskId} did not satisfy the expected predicate.`);
}

export async function startPhase4GraphQLServer(params: {
  store: IndexerStore;
  analytics?: AnalyticsEngine;
  host?: string;
}) {
  const port = (await graphqlPortAllocator.allocate(1))[0]!;
  const server = createIndexerGraphQLServer({
    store: params.store,
    analytics: params.analytics,
    host: params.host ?? '127.0.0.1',
    port,
  });
  const address = await server.start();

  return {
    ...server,
    address,
    stop: async () => {
      await server.stop();
      await graphqlPortAllocator.release([port]);
    },
  };
}

export async function postGraphQL<T>(address: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(address, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.map((error) => error.message).join('; ') ?? `GraphQL request failed with ${response.status}.`);
  }
  if (!payload.data) {
    throw new Error('GraphQL response did not include data.');
  }
  return payload.data;
}
