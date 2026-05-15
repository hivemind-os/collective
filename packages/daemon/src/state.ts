import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AgentCache,
  type BlobStore,
  createDID,
  EventSubscription,
  FilesystemBlobStore,
  loadOrCreateKeypair,
  MeshSuiClient,
  RegistryClient,
  SqliteCursorStore,
  SpendingPolicyEngine,
  TaskClient,
} from '@agentic-mesh/core';
import { PaymentRail, type DID } from '@agentic-mesh/types';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { DaemonFullConfig } from './config.js';

export interface DaemonStatusBase {
  did: DID;
  address: string;
  uptime: number;
  spendingToday: string;
  providerRunning: boolean;
}

export class DaemonState {
  readonly keypair: Ed25519Keypair;
  readonly did: DID;
  readonly suiClient: MeshSuiClient;
  readonly registryClient: RegistryClient;
  readonly taskClient: TaskClient;
  readonly agentCache: AgentCache;
  readonly blobStore: BlobStore;
  readonly spendingPolicy: SpendingPolicyEngine;
  readonly network: DaemonFullConfig['network'];
  readonly startedAt: number;
  readonly address: string;

  private readonly cursorStore: SqliteCursorStore;
  private readonly subscriptions: EventSubscription[];
  private providerRunning = false;

  private constructor(params: {
    keypair: Ed25519Keypair;
    did: DID;
    suiClient: MeshSuiClient;
    registryClient: RegistryClient;
    taskClient: TaskClient;
    agentCache: AgentCache;
    blobStore: BlobStore;
    spendingPolicy: SpendingPolicyEngine;
    cursorStore: SqliteCursorStore;
    network: DaemonFullConfig['network'];
  }) {
    this.keypair = params.keypair;
    this.did = params.did;
    this.suiClient = params.suiClient;
    this.registryClient = params.registryClient;
    this.taskClient = params.taskClient;
    this.agentCache = params.agentCache;
    this.blobStore = params.blobStore;
    this.spendingPolicy = params.spendingPolicy;
    this.cursorStore = params.cursorStore;
    this.network = params.network;
    this.subscriptions = [];
    this.startedAt = Date.now();
    this.address = this.keypair.getPublicKey().toSuiAddress();
  }

  static async create(config: DaemonFullConfig): Promise<DaemonState> {
    await mkdir(config.daemon.dataDir, { recursive: true });
    await mkdir(config.identity.dataDir, { recursive: true });
    await mkdir(config.blobstore.baseDir, { recursive: true });

    const identity = loadOrCreateKeypair(config.identity.dataDir);
    const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
    const did = createDID(identity.publicKey);
    const suiClient = new MeshSuiClient(config.network);
    const registryClient = new RegistryClient(suiClient, config.network);
    const taskClient = new TaskClient(suiClient, config.network);
    const agentCache = new AgentCache(join(config.daemon.dataDir, 'agent-cache.sqlite'));
    const blobStore = new FilesystemBlobStore(config.blobstore.baseDir);
    const spendingPolicy = new SpendingPolicyEngine({
      policy: config.spending,
      dbPath: join(config.daemon.dataDir, 'spending.sqlite'),
    });
    const cursorStore = new SqliteCursorStore(join(config.daemon.dataDir, 'event-cursors.sqlite'));

    return new DaemonState({
      keypair,
      did,
      suiClient,
      registryClient,
      taskClient,
      agentCache,
      blobStore,
      spendingPolicy,
      cursorStore,
      network: config.network,
    });
  }

  setProviderRunning(providerRunning: boolean): void {
    this.providerRunning = providerRunning;
  }

  getStatusBase(): DaemonStatusBase {
    return {
      did: this.did,
      address: this.address,
      uptime: Date.now() - this.startedAt,
      spendingToday: formatMistAsSui(this.spendingPolicy.getSpent('day', PaymentRail.SUI_ESCROW)),
      providerRunning: this.providerRunning,
    };
  }

  async shutdown(): Promise<void> {
    this.providerRunning = false;
    for (const subscription of this.subscriptions) {
      subscription.stop();
    }

    this.subscriptions.length = 0;
    this.cursorStore.close();
    this.agentCache.close();
    this.spendingPolicy.close();
  }
}

function formatMistAsSui(amountMist: bigint): string {
  const whole = amountMist / 1_000_000_000n;
  const fractional = amountMist % 1_000_000_000n;

  if (fractional === 0n) {
    return `${whole.toString()} SUI`;
  }

  return `${whole.toString()}.${fractional.toString().padStart(9, '0').replace(/0+$/, '')} SUI`;
}
