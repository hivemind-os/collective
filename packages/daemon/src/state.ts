import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AgentCache,
  type AuthProvider,
  type BlobStore,
  type OAuthConfig,
  createDID,
  Ed25519AuthProvider,
  EventSubscription,
  FilesystemBlobStore,
  HybridBlobStore,
  loadOrCreateKeypair,
  MeshSuiClient,
  RegistryClient,
  SqliteCursorStore,
  SpendingPolicyEngine,
  TaskClient,
  WalrusBlobStore,
  ZkLoginProvider,
  ZkLoginSessionStore,
} from '@agentic-mesh/core';
import { PaymentRail, type DID } from '@agentic-mesh/types';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { DaemonFullConfig } from './config.js';

export interface DaemonStatusBase {
  did: DID;
  address: string;
  uptime: number;
  spendingToday: string;
  providerRunning: boolean;
  authMode: AuthProvider['mode'];
  authenticated: boolean;
}

export interface DaemonIdentityContext {
  authProvider: AuthProvider;
  did: DID;
  identityKeypair: Ed25519Keypair;
}

export class DaemonState {
  readonly keypair: Signer;
  readonly identityKeypair: Ed25519Keypair;
  readonly authProvider: AuthProvider;
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
    keypair: Signer;
    identityKeypair: Ed25519Keypair;
    authProvider: AuthProvider;
    did: DID;
    suiClient: MeshSuiClient;
    registryClient: RegistryClient;
    taskClient: TaskClient;
    agentCache: AgentCache;
    blobStore: BlobStore;
    spendingPolicy: SpendingPolicyEngine;
    cursorStore: SqliteCursorStore;
    network: DaemonFullConfig['network'];
    address: string;
  }) {
    this.keypair = params.keypair;
    this.identityKeypair = params.identityKeypair;
    this.authProvider = params.authProvider;
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
    this.address = params.address;
  }

  static async create(config: DaemonFullConfig, identityContext?: DaemonIdentityContext): Promise<DaemonState> {
    await mkdir(config.daemon.dataDir, { recursive: true });
    await mkdir(config.identity.dataDir, { recursive: true });

    const context = identityContext ?? (await createDaemonIdentityContext(config));
    if (!context.authProvider.isAuthenticated()) {
      throw new Error('A valid auth session is required before the daemon can start.');
    }

    const suiClient = new MeshSuiClient(config.network);
    const registryClient = new RegistryClient(suiClient, config.network);
    const taskClient = new TaskClient(suiClient, config.network);
    const agentCache = new AgentCache(join(config.daemon.dataDir, 'agent-cache.sqlite'));
    const blobStore = await createBlobStore(config);
    const spendingPolicy = new SpendingPolicyEngine({
      policy: config.spending,
      dbPath: join(config.daemon.dataDir, 'spending.sqlite'),
    });
    const cursorStore = new SqliteCursorStore(join(config.daemon.dataDir, 'event-cursors.sqlite'));
    const address = await context.authProvider.getAddress();

    return new DaemonState({
      keypair: context.authProvider.toSuiSigner(),
      identityKeypair: context.identityKeypair,
      authProvider: context.authProvider,
      did: context.did,
      suiClient,
      registryClient,
      taskClient,
      agentCache,
      blobStore,
      spendingPolicy,
      cursorStore,
      network: config.network,
      address,
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
      authMode: this.authProvider.mode,
      authenticated: this.authProvider.isAuthenticated(),
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

export async function createDaemonIdentityContext(config: DaemonFullConfig): Promise<DaemonIdentityContext> {
  await mkdir(config.daemon.dataDir, { recursive: true });
  await mkdir(config.identity.dataDir, { recursive: true });

  const identity = loadOrCreateKeypair(config.identity.dataDir);
  const identityKeypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const did = createDID(identity.publicKey);

  if (config.auth.mode !== 'zklogin') {
    return {
      authProvider: new Ed25519AuthProvider(identityKeypair),
      did,
      identityKeypair,
    };
  }

  const suiClient = new MeshSuiClient(config.network);
  const sessionStore = new ZkLoginSessionStore(
    join(config.daemon.dataDir, 'sessions'),
    deriveSessionEncryptionKey(identity.secretKey),
  );
  const authProvider = new ZkLoginProvider({
    client: suiClient.client,
    oauth: buildOAuthConfig(config),
    sessionStore,
  });
  await authProvider.restoreSession();

  return {
    authProvider,
    did,
    identityKeypair,
  };
}

export function buildOAuthConfig(config: DaemonFullConfig, redirectUri = ''): OAuthConfig {
  if (config.auth.google?.clientId) {
    return {
      provider: 'google',
      clientId: config.auth.google.clientId,
      redirectUri,
    };
  }

  if (config.auth.apple?.clientId) {
    return {
      provider: 'apple',
      clientId: config.auth.apple.clientId,
      redirectUri,
    };
  }

  throw new Error('OAuth provider configuration is incomplete.');
}

async function createBlobStore(config: DaemonFullConfig): Promise<BlobStore> {
  switch (config.blobstore.mode) {
    case 'filesystem': {
      const dataDir = config.blobstore.filesystem?.dataDir;
      if (!dataDir) {
        throw new Error('blobstore.filesystem.dataDir is required for filesystem mode.');
      }

      await mkdir(dataDir, { recursive: true });
      return new FilesystemBlobStore(dataDir);
    }
    case 'walrus': {
      const walrus = config.blobstore.walrus;
      if (!walrus?.publisherUrl || !walrus.aggregatorUrl) {
        throw new Error('blobstore.walrus.publisherUrl and blobstore.walrus.aggregatorUrl are required.');
      }

      return new WalrusBlobStore(walrus);
    }
    case 'hybrid': {
      const dataDir = config.blobstore.filesystem?.dataDir;
      const walrus = config.blobstore.walrus;
      if (!dataDir) {
        throw new Error('blobstore.filesystem.dataDir is required for hybrid mode.');
      }
      if (!walrus?.publisherUrl || !walrus.aggregatorUrl) {
        throw new Error('blobstore.walrus.publisherUrl and blobstore.walrus.aggregatorUrl are required for hybrid mode.');
      }

      await mkdir(dataDir, { recursive: true });
      return new HybridBlobStore(
        new WalrusBlobStore(walrus),
        new FilesystemBlobStore(dataDir),
        config.blobstore.hybrid,
      );
    }
    default:
      throw new Error(`Unsupported blobstore mode: ${String((config.blobstore as { mode?: unknown }).mode)}`);
  }
}

function deriveSessionEncryptionKey(secretKey: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(Buffer.from(secretKey))
    .update('agentic-mesh:zklogin-session:v1')
    .digest();
}

function formatMistAsSui(amountMist: bigint): string {
  const whole = amountMist / 1_000_000_000n;
  const fractional = amountMist % 1_000_000_000n;

  if (fractional === 0n) {
    return `${whole.toString()} SUI`;
  }

  return `${whole.toString()}.${fractional.toString().padStart(9, '0').replace(/0+$/, '')} SUI`;
}