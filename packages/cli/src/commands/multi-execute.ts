import { loadConfig as loadDaemonConfig, type DaemonFullConfig } from '@agentic-mesh/daemon/config';
import { DaemonState } from '@agentic-mesh/daemon/state';
import {
  runMeshMultiExecute,
  type MeshMultiExecuteParams,
  type MeshMultiExecuteResult,
  type MeshToolContext,
} from '@agentic-mesh/mcp-server';
import { AggregationMode, ProviderSelectionStrategy } from '@agentic-mesh/types';

import { info, success, table } from '../utils/output.js';

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

export interface MultiExecuteCommandDeps {
  loadConfig?: () => DaemonFullConfig;
  createState?: (config: DaemonFullConfig) => Promise<DaemonStateLike>;
  runMultiExecute?: (params: MeshMultiExecuteParams, context: MeshToolContext) => Promise<MeshMultiExecuteResult>;
}

export async function handleMultiExecute(args: string[] = [], deps: MultiExecuteCommandDeps = {}): Promise<number> {
  const capability = readRequiredFlag(args, '--capability');
  const input = parseJsonInput(readRequiredFlag(args, '--input'));
  const fanOutCount = readOptionalInteger(args, '--fan-out');
  const strategy = readOptionalStrategy(args, '--strategy');
  const aggregation = readOptionalAggregation(args, '--aggregation');
  const maxPricePerProvider = readOptionalInteger(args, '--max-price-per-provider');
  const timeout = readOptionalInteger(args, '--timeout');

  const config = deps.loadConfig?.() ?? loadDaemonConfig();
  const state = await (deps.createState?.(config) ?? DaemonState.create(config));

  try {
    const result = await (deps.runMultiExecute ?? runMeshMultiExecute)({
      capability,
      input,
      fanOutCount,
      strategy,
      aggregation,
      maxPricePerProvider,
      timeout,
    }, toMeshToolContext(state));

    info(`Selected ${result.providers.length} provider(s) for ${result.capability}.`);
    table(
      ['Provider', 'Price (MIST)', 'Reputation', 'Latency (ms)'],
      result.providers.map((provider) => [
        provider.did,
        provider.price_mist,
        provider.reputation.toFixed(2),
        provider.estimated_latency_ms?.toString() ?? '-',
      ]),
    );
    table(
      ['Provider', 'Status', 'Duration (ms)', 'Summary'],
      result.results.map((entry) => [
        entry.provider,
        entry.status,
        entry.duration_ms.toString(),
        entry.error ?? summarizeValue(entry.result),
      ]),
    );
    success(`Total cost: ${result.total_cost_mist} MIST`);
    if (result.aggregated_result !== undefined) {
      console.log(JSON.stringify(result.aggregated_result, null, 2));
    }
    return 0;
  } finally {
    await state.shutdown();
  }
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

function summarizeValue(value: unknown): string {
  if (value === undefined) {
    return '-';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function parseJsonInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid --input JSON.');
  }
}

function readOptionalStrategy(args: string[], flag: string): MeshMultiExecuteParams['strategy'] {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    return undefined;
  }
  if (Object.values(ProviderSelectionStrategy).includes(value as ProviderSelectionStrategy)) {
    return value as ProviderSelectionStrategy;
  }
  throw new Error(`Invalid ${flag}.`);
}

function readOptionalAggregation(args: string[], flag: string): MeshMultiExecuteParams['aggregation'] {
  const value = readOptionalFlag(args, flag);
  if (!value) {
    return undefined;
  }
  if (Object.values(AggregationMode).includes(value as AggregationMode)) {
    return value as AggregationMode;
  }
  throw new Error(`Invalid ${flag}.`);
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
    throw new Error('Usage: mesh multi-execute --capability <cap> --input <json> [--fan-out <n>] [--strategy <strategy>] [--aggregation <mode>] [--max-price-per-provider <mist>] [--timeout <ms>]');
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
