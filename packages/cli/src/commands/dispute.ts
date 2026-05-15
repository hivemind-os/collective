import { readFile } from 'node:fs/promises';

import { DEFAULT_WALRUS_AGGREGATOR_URL, DEFAULT_WALRUS_PUBLISHER_URL, DisputeClient, MeshSuiClient, WalrusBlobStore, loadOrCreateKeypair } from '@agentic-mesh/core';
import { DisputeStatus, type Dispute } from '@agentic-mesh/types';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadMeshConfig, type MeshCliConfig } from './config.js';
import { formatMistToSui } from './wallet.js';
import { info, success, table } from '../utils/output.js';

interface EvidenceStoreLike {
  store(data: Uint8Array): Promise<{ blobId: string }>;
}

export interface DisputeCommandDeps {
  loadConfig?: () => MeshCliConfig;
  loadKeypair?: (dataDir: string) => { secretKey: Uint8Array };
  createClient?: (config: MeshCliConfig) => Pick<
    DisputeClient,
    'openDispute' | 'respondToDispute' | 'acceptResolution' | 'getDispute' | 'getDisputeByTask'
  >;
  createBlobStore?: () => EvidenceStoreLike;
  readEvidenceFile?: (path: string) => Promise<string>;
}

export async function handleDispute(subcommand?: string, args: string[] = [], deps: DisputeCommandDeps = {}): Promise<number> {
  switch (subcommand) {
    case 'open':
      return await openDispute(args, deps);
    case 'respond':
      return await respondToDispute(args, deps);
    case 'accept':
      return await acceptResolution(args, deps);
    case 'status':
      return await showStatus(args, deps);
    default:
      throw new Error('Usage: mesh dispute <open|respond|accept|status>');
  }
}

async function openDispute(args: string[], deps: DisputeCommandDeps): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: mesh dispute open <task-id> --split-mist <mist> (--evidence <text> | --evidence-file <path> | --evidence-blob-id <id>) [--arbitrator <address>]');
  }

  const proposedSplitMist = readMistFlag(args, '--split-mist');
  const arbitratorAddress = readOptionalFlag(args, '--arbitrator');
  const evidenceBlobId = await resolveEvidenceBlobId(args, deps);
  const { client, keypair } = loadDisputeContext(deps);
  const result = await client.openDispute({
    taskId,
    evidenceBlobId,
    proposedSplitMist,
    arbitratorAddress,
    signer: keypair,
  });

  success(`Opened dispute ${result.disputeId}`);
  console.log(`Task ID: ${taskId}`);
  console.log(`Evidence Blob: ${evidenceBlobId}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function respondToDispute(args: string[], deps: DisputeCommandDeps): Promise<number> {
  const disputeId = args[0];
  if (!disputeId) {
    throw new Error('Usage: mesh dispute respond <dispute-id> --split-mist <mist> (--evidence <text> | --evidence-file <path> | --evidence-blob-id <id>)');
  }

  const proposedSplitMist = readMistFlag(args, '--split-mist');
  const evidenceBlobId = await resolveEvidenceBlobId(args, deps);
  const { client, keypair } = loadDisputeContext(deps);
  const result = await client.respondToDispute({
    disputeId,
    evidenceBlobId,
    proposedSplitMist,
    signer: keypair,
  });

  success(`Responded to dispute ${disputeId}`);
  console.log(`Evidence Blob: ${evidenceBlobId}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function acceptResolution(args: string[], deps: DisputeCommandDeps): Promise<number> {
  const disputeId = args[0];
  const taskId = args[1];
  if (!disputeId || !taskId) {
    throw new Error('Usage: mesh dispute accept <dispute-id> <task-id>');
  }

  const { client, keypair } = loadDisputeContext(deps);
  const result = await client.acceptResolution({ disputeId, taskId, signer: keypair });

  success(`Resolved dispute ${disputeId}`);
  console.log(`Requester Amount (SUI): ${formatMistToSui(result.requesterAmount)}`);
  console.log(`Provider Amount (SUI): ${formatMistToSui(result.providerAmount)}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function showStatus(args: string[], deps: DisputeCommandDeps): Promise<number> {
  const { client } = loadDisputeContext(deps);
  if (args[0] === '--task') {
    const taskId = readRequiredFlagValue(args, '--task');
    const dispute = await client.getDisputeByTask(taskId);
    if (!dispute) {
      throw new Error(`No dispute found for task ${taskId}.`);
    }
    return renderDisputeStatus(dispute);
  }

  const disputeId = args[0]?.trim();
  if (!disputeId) {
    throw new Error('Usage: mesh dispute status <dispute-id> | mesh dispute status --task <task-id>');
  }

  const dispute = await client.getDispute(disputeId);
  if (!dispute) {
    throw new Error(`Dispute ${disputeId} was not found.`);
  }

  return renderDisputeStatus(dispute);
}

function renderDisputeStatus(dispute: Dispute): number {

  info(`Dispute ${dispute.id}`);
  table(
    ['Field', 'Value'],
    [
      ['Task', dispute.taskId],
      ['Status', DisputeStatus[dispute.status] ?? 'UNKNOWN'],
      ['Requester', dispute.requester],
      ['Provider', dispute.provider],
      ['Escrow (SUI)', formatMistToSui(dispute.escrowAmount)],
      ['Requester Proposal (SUI)', formatMistToSui(dispute.requesterProposedSplit)],
      ['Provider Proposal (SUI)', formatMistToSui(dispute.providerProposedSplit)],
      ['Evidence', dispute.requesterEvidenceBlob],
      ['Counter Evidence', dispute.providerEvidenceBlob ?? '-'],
      ['Arbitrator', dispute.arbitrator ?? '-'],
      ['Opened', new Date(dispute.openedAt).toISOString()],
      ['Resolved', dispute.resolvedAt ? new Date(dispute.resolvedAt).toISOString() : '-'],
    ],
  );
  return 0;
}

function loadDisputeContext(deps: DisputeCommandDeps): {
  config: MeshCliConfig;
  keypair: Ed25519Keypair;
  client: Pick<DisputeClient, 'openDispute' | 'respondToDispute' | 'acceptResolution' | 'getDispute' | 'getDisputeByTask'>;
} {
  const config = (deps.loadConfig ?? loadMeshConfig)();
  if (!config.network.packageId) {
    throw new Error('network.packageId must be configured before disputing tasks.');
  }

  const identity = (deps.loadKeypair ?? loadOrCreateKeypair)(config.identity.dataDir);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const client = deps.createClient?.(config) ?? new DisputeClient(new MeshSuiClient(config.network), config.network);
  return { config, keypair, client };
}

async function resolveEvidenceBlobId(args: string[], deps: DisputeCommandDeps): Promise<string> {
  const directBlobId = readOptionalFlag(args, '--evidence-blob-id');
  const inlineEvidence = readOptionalFlag(args, '--evidence');
  const filePath = readOptionalFlag(args, '--evidence-file');
  const providedSources = [directBlobId, inlineEvidence, filePath].filter((value) => value !== undefined);
  if (providedSources.length !== 1) {
    throw new Error('Specify exactly one of --evidence, --evidence-file, or --evidence-blob-id.');
  }
  if (directBlobId) {
    return directBlobId;
  }

  const readEvidenceFile = deps.readEvidenceFile ?? (async (path: string) => await readFile(path, 'utf8'));
  const contents = inlineEvidence ?? (filePath ? await readEvidenceFile(filePath) : undefined);
  if (!contents) {
    throw new Error('Evidence is required. Use --evidence, --evidence-file, or --evidence-blob-id.');
  }

  const blobStore = deps.createBlobStore?.() ?? new WalrusBlobStore({
    publisherUrl: process.env.MESH_WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL,
    aggregatorUrl: process.env.MESH_WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL,
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

function readRequiredFlagValue(args: string[], flag: string): string {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}
