import { loadConfig as loadDaemonConfig, type DaemonFullConfig } from '@agentic-mesh/daemon/config';
import { DaemonState } from '@agentic-mesh/daemon/state';
import {
  runMeshMeteredExecute,
  runMeshVerifyResult,
  type MeshMeteredExecuteParams,
  type MeshToolContext,
} from '@agentic-mesh/mcp-server';
import { MeshSuiClient, TaskClient } from '@agentic-mesh/core';
import { PaymentScheme, TaskStatus } from '@agentic-mesh/types';

import { loadMeshConfig } from './config.js';
import { formatMistToSui } from './wallet.js';
import { success, table } from '../utils/output.js';

interface DaemonStateLike {
  did: MeshToolContext['did'];
  keypair: MeshToolContext['keypair'];
  suiClient: MeshToolContext['suiClient'];
  registryClient: MeshToolContext['registryClient'];
  taskClient: MeshToolContext['taskClient'];
  agentCache: MeshToolContext['agentCache'];
  blobStore: MeshToolContext['blobStore'];
  spendingPolicy: MeshToolContext['spendingPolicy'];
  network: MeshToolContext['networkConfig'];
  relayAuthProvider?: MeshToolContext['relayAuthProvider'];
  x402Client?: MeshToolContext['x402Client'];
  shutdown(): Promise<void>;
}

export interface MeteringCommandDeps {
  loadConfig?: () => DaemonFullConfig;
  createState?: (config: DaemonFullConfig) => Promise<DaemonStateLike>;
  runMeteredExecute?: (params: MeshMeteredExecuteParams, context: MeshToolContext) => Promise<Awaited<ReturnType<typeof runMeshMeteredExecute>>>;
  runVerify?: (params: { task_id: string }, context: MeshToolContext) => Promise<Awaited<ReturnType<typeof runMeshVerifyResult>>>;
}

export async function handleMetering(subcommand?: string, args: string[] = [], deps: MeteringCommandDeps = {}): Promise<number> {
  switch (subcommand) {
    case 'execute':
      return await handleMeteringExecute(args, deps);
    case 'verify':
      return await handleMeteringVerify(args, deps);
    case 'status':
      return await handleMeteringStatus(args);
    default:
      throw new Error('Usage: mesh metering <execute|verify|status>');
  }
}

async function handleMeteringExecute(args: string[], deps: MeteringCommandDeps): Promise<number> {
  const capability = readRequiredFlag(args, '--capability');
  const input = readRequiredFlag(args, '--input');
  const maxPriceMist = readRequiredInteger(args, '--max-price-mist');
  const unitPriceMist = readRequiredInteger(args, '--unit-price-mist');
  const providerDid = readOptionalFlag(args, '--provider-did');
  const timeoutSeconds = readOptionalInteger(args, '--timeout-seconds');

  const config = deps.loadConfig?.() ?? loadDaemonConfig();
  const state = await (deps.createState?.(config) ?? DaemonState.create(config));
  try {
    const result = await (deps.runMeteredExecute ?? runMeshMeteredExecute)({
      capability,
      input,
      provider_did: providerDid,
      max_price_mist: maxPriceMist,
      unit_price_mist: unitPriceMist,
      timeout_seconds: timeoutSeconds,
    }, toMeshToolContext(state));

    success(`Metered task ${result.task_id}`);
    table(
      ['Field', 'Value'],
      [
        ['Provider', result.provider_did],
        ['Price (SUI)', formatMistToSui(BigInt(result.actual_price_mist))],
        ['Max Price (SUI)', formatMistToSui(BigInt(result.max_price_mist))],
        ['Unit Price (SUI)', formatMistToSui(BigInt(result.unit_price_mist))],
        ['Units', result.metered_units.toString()],
        ['Verified', result.verified ? 'yes' : 'no'],
      ],
    );
    console.log(result.result);
    return 0;
  } finally {
    await state.shutdown();
  }
}

async function handleMeteringVerify(args: string[], deps: MeteringCommandDeps): Promise<number> {
  const taskId = args[0]?.trim();
  if (!taskId) {
    throw new Error('Usage: mesh metering verify <task-id>');
  }

  const config = deps.loadConfig?.() ?? loadDaemonConfig();
  const state = await (deps.createState?.(config) ?? DaemonState.create(config));
  try {
    const result = await (deps.runVerify ?? runMeshVerifyResult)({ task_id: taskId }, toMeshToolContext(state));
    success(`Verification ${result.verified ? 'passed' : 'failed'} for ${result.task_id}`);
    table(
      ['Field', 'Value'],
      [
        ['Verified', result.verified ? 'yes' : 'no'],
        ['Units', result.metered_units.toString()],
        ['Verification Hash', result.verification_hash ?? '-'],
      ],
    );
    return result.verified ? 0 : 1;
  } finally {
    await state.shutdown();
  }
}

async function handleMeteringStatus(args: string[]): Promise<number> {
  const taskId = args[0]?.trim();
  if (!taskId) {
    throw new Error('Usage: mesh metering status <task-id>');
  }

  const config = loadMeshConfig();
  const taskClient = new TaskClient(new MeshSuiClient(config.network), config.network);
  const task = await taskClient.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  success(`Metered task ${task.id}`);
  table(
    ['Field', 'Value'],
    [
      ['Status', TaskStatus[task.status] ?? 'UNKNOWN'],
      ['Scheme', task.paymentScheme ? PaymentScheme[task.paymentScheme] : 'EXACT'],
      ['Actual Price (SUI)', formatMistToSui(task.price)],
      ['Max Price (SUI)', formatMistToSui(task.maxPrice ?? task.price)],
      ['Unit Price (SUI)', formatMistToSui(task.unitPrice ?? 0n)],
      ['Units', task.meteredUnits?.toString() ?? '0'],
      ['Verification Hash', task.verificationHash ?? '-'],
      ['Provider', task.provider ?? '-'],
    ],
  );
  return 0;
}

function toMeshToolContext(state: DaemonStateLike): MeshToolContext {
  return {
    did: state.did,
    keypair: state.keypair,
    suiClient: state.suiClient,
    registryClient: state.registryClient,
    taskClient: state.taskClient,
    agentCache: state.agentCache,
    blobStore: state.blobStore,
    spendingPolicy: state.spendingPolicy,
    networkConfig: state.network,
    relayAuthProvider: state.relayAuthProvider,
    x402Client: state.x402Client,
  };
}

function readRequiredFlag(args: string[], flag: string): string {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    throw new Error('Usage: mesh metering execute --capability <cap> --input <text> --max-price-mist <mist> --unit-price-mist <mist> [--provider-did <did>] [--timeout-seconds <seconds>]');
  }
  return value;
}

function readRequiredInteger(args: string[], flag: string): number {
  const value = readOptionalInteger(args, flag);
  if (value === undefined) {
    throw new Error(`Missing or invalid ${flag}.`);
  }
  return value;
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
