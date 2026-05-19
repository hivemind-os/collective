import { readFile } from 'node:fs/promises';

import {
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  loadOrCreateKeypair,
  MarketplaceClient,
  MeshSuiClient,
  WalrusBlobStore,
} from '@hivemind-os/collective-core';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadMeshConfig, type MeshCliConfig } from './config.js';
import { info, success, table } from '../utils/output.js';

interface InputStoreLike {
  store(data: Uint8Array): Promise<{ blobId: string }>;
}

export interface MarketplaceCommandDeps {
  loadConfig?: () => MeshCliConfig;
  loadKeypair?: (dataDir: string) => { secretKey: Uint8Array };
  createClient?: (config: MeshCliConfig) => Pick<
    MarketplaceClient,
    'postOpenTask' | 'browseOpenTasks' | 'placeBid' | 'acceptBid'
  >;
  createBlobStore?: () => InputStoreLike;
  readInputFile?: (path: string) => Promise<string>;
}

export async function handleMarketplace(
  subcommand?: string,
  args: string[] = [],
  deps: MarketplaceCommandDeps = {},
): Promise<number> {
  switch (subcommand) {
    case 'post':
      return await postMarketplaceTask(args, deps);
    case 'browse':
      return await browseMarketplaceTasks(args, deps);
    case 'bid':
      return await placeMarketplaceBid(args, deps);
    case 'accept-bid':
      return await acceptMarketplaceBid(args, deps);
    default:
      throw new Error('Usage: mesh marketplace <post|browse|bid|accept-bid>');
  }
}

async function postMarketplaceTask(args: string[], deps: MarketplaceCommandDeps): Promise<number> {
  const capability = args[0];
  if (!capability) {
    throw new Error('Usage: mesh marketplace post <capability> --category <category> --price-mist <mist> (--input <text> | --input-file <path> | --input-blob-id <id>) [--agreement-hash <value>] [--dispute-window-ms <ms>] [--expiry-hours <hours>]');
  }

  const category = readRequiredFlag(args, '--category');
  const priceMist = readMistFlag(args, '--price-mist');
  const inputBlobId = await resolveInputBlobId(args, deps);
  const agreementHash = readOptionalFlag(args, '--agreement-hash');
  const disputeWindowMs = readOptionalInteger(args, '--dispute-window-ms') ?? 60_000;
  const expiryHours = readOptionalInteger(args, '--expiry-hours') ?? 24;
  const { client, keypair } = loadMarketplaceContext(deps);
  const result = await client.postOpenTask({
    capability,
    category,
    inputBlobId,
    agreementHash,
    priceMist,
    disputeWindowMs,
    expiryHours,
    signer: keypair,
  });

  success(`Posted marketplace task ${result.taskId}`);
  console.log(`Category: ${category}`);
  console.log(`Input Blob: ${inputBlobId}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function browseMarketplaceTasks(args: string[], deps: MarketplaceCommandDeps): Promise<number> {
  const { client } = loadMarketplaceContext(deps);
  const tasks = await client.browseOpenTasks({
    category: readOptionalFlag(args, '--category'),
    minPriceMist: readOptionalMist(args, '--min-price-mist'),
    maxPriceMist: readOptionalMist(args, '--max-price-mist'),
    limit: readOptionalInteger(args, '--limit') ?? 20,
  });

  info(`Found ${tasks.length} open marketplace task(s).`);
  table(
    ['Task', 'Category', 'Capability', 'Price (MIST)', 'Requester'],
    tasks.map((task) => [task.id, task.category, task.capability, task.price.toString(), task.requester]),
  );
  return 0;
}

async function placeMarketplaceBid(args: string[], deps: MarketplaceCommandDeps): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: mesh marketplace bid <task-id> --price-mist <mist> [--reputation-score <score>] [--evidence <text>]');
  }

  const { client, keypair } = loadMarketplaceContext(deps);
  const result = await client.placeBid({
    taskId,
    bidPriceMist: readMistFlag(args, '--price-mist'),
    reputationScore: readOptionalMist(args, '--reputation-score'),
    evidenceBlob: readOptionalFlag(args, '--evidence'),
    signer: keypair,
  });

  success(`Placed bid ${result.bidId}`);
  console.log(`Task ID: ${taskId}`);
  console.log(`Reputation Score: ${result.reputationScore.toString()}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function acceptMarketplaceBid(args: string[], deps: MarketplaceCommandDeps): Promise<number> {
  const taskId = args[0];
  const bidId = args[1];
  if (!taskId || !bidId) {
    throw new Error('Usage: mesh marketplace accept-bid <task-id> <bid-id> [--keep-other-bids]');
  }

  const { client, keypair } = loadMarketplaceContext(deps);
  const result = await client.acceptBid({
    taskId,
    bidId,
    rejectCompeting: !args.includes('--keep-other-bids'),
    signer: keypair,
  });

  success(`Accepted bid ${bidId}`);
  console.log(`Rejected competing bids: ${result.rejectedBidIds.length}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

function loadMarketplaceContext(deps: MarketplaceCommandDeps): {
  config: MeshCliConfig;
  keypair: Ed25519Keypair;
  client: Pick<MarketplaceClient, 'postOpenTask' | 'browseOpenTasks' | 'placeBid' | 'acceptBid'>;
} {
  const config = (deps.loadConfig ?? loadMeshConfig)();
  if (!config.network.packageId) {
    throw new Error('network.packageId must be configured before using marketplace commands.');
  }

  const identity = (deps.loadKeypair ?? ((dir: string) => loadOrCreateKeypair(dir, { allowInsecureFileStorage: true })))(config.identity.dataDir);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const client = deps.createClient?.(config) ?? new MarketplaceClient(new MeshSuiClient(config.network), config.network);
  return { config, keypair, client };
}

async function resolveInputBlobId(args: string[], deps: MarketplaceCommandDeps): Promise<string> {
  const directBlobId = readOptionalFlag(args, '--input-blob-id');
  const inlineInput = readOptionalFlag(args, '--input');
  const filePath = readOptionalFlag(args, '--input-file');
  const providedSources = [directBlobId, inlineInput, filePath].filter((value) => value !== undefined);
  if (providedSources.length !== 1) {
    throw new Error('Specify exactly one of --input, --input-file, or --input-blob-id.');
  }
  if (directBlobId) {
    return directBlobId;
  }

  const readInputFile = deps.readInputFile ?? (async (path: string) => await readFile(path, 'utf8'));
  const contents = inlineInput ?? (filePath ? await readInputFile(filePath) : undefined);
  if (!contents) {
    throw new Error('Task input is required. Use --input, --input-file, or --input-blob-id.');
  }

  const blobStore = deps.createBlobStore?.() ?? new WalrusBlobStore({
    publisherUrl: process.env.COLLECTIVE_WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL,
    aggregatorUrl: process.env.COLLECTIVE_WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL,
  });
  const stored = await blobStore.store(new TextEncoder().encode(contents));
  return stored.blobId;
}

function readMistFlag(args: string[], flag: string): bigint {
  const value = readOptionalFlag(args, flag);
  if (!value || !/^\d+$/.test(value.trim())) {
    throw new Error(`Missing or invalid ${flag}.`);
  }
  return BigInt(value.trim());
}

function readOptionalMist(args: string[], flag: string): bigint | undefined {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Missing or invalid ${flag}.`);
  }
  return BigInt(value.trim());
}

function readOptionalInteger(args: string[], flag: string): number | undefined {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Missing or invalid ${flag}.`);
  }
  return parsed;
}

function readRequiredFlag(args: string[], flag: string): string {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    throw new Error(`Missing required ${flag}.`);
  }
  return value;
}

function readOptionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}
