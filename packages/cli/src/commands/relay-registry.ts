import { loadOrCreateKeypair, MeshSuiClient, RelayRegistryClient } from '@hivemind-os/collective-core';
import type { RelayNode } from '@hivemind-os/collective-types';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadMeshConfig, type MeshCliConfig } from './config.js';
import { formatMistToSui } from './wallet.js';
import { info, success, table } from '../utils/output.js';

export interface RelayRegistryCommandDeps {
  loadConfig?: () => MeshCliConfig;
  loadKeypair?: (dataDir: string) => { secretKey: Uint8Array };
  createClient?: (config: MeshCliConfig) => Pick<
    RelayRegistryClient,
    'registerRelay' | 'listRelays' | 'heartbeat' | 'deactivateRelay'
  >;
}

export async function handleRelayRegistry(
  subcommand?: string,
  args: string[] = [],
  deps: RelayRegistryCommandDeps = {},
): Promise<number> {
  switch (subcommand) {
    case 'register':
      return await registerRelay(args, deps);
    case 'list':
      return await listRelays(deps);
    case 'heartbeat':
      return await heartbeatRelay(args, deps);
    case 'deactivate':
      return await deactivateRelay(args, deps);
    default:
      throw new Error('Usage: mesh relay <register|list|heartbeat|deactivate>');
  }
}

async function registerRelay(args: string[], deps: RelayRegistryCommandDeps): Promise<number> {
  const endpoint = readRequiredFlag(args, '--endpoint');
  const stakeId = readRequiredFlag(args, '--stake-id');
  const region = readRequiredFlag(args, '--region');
  const fee = Number(readRequiredFlag(args, '--fee'));
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) {
    throw new Error('Usage: mesh relay register --endpoint <url> --stake-id <id> --region <region> --fee <bps> [--capabilities a,b]');
  }

  const capabilities = readCapabilities(args);
  const { client, keypair } = loadRelayContext(deps);
  const result = await client.registerRelay({
    endpoint,
    stakeId,
    region,
    routingFeeBps: fee,
    capabilities,
    signer: keypair,
  });

  success('Relay registered.');
  console.log(`Relay ID: ${result.relayId}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  console.log(`Capabilities: ${capabilities.join(', ')}`);
  return 0;
}

async function listRelays(deps: RelayRegistryCommandDeps): Promise<number> {
  const { client } = loadRelayContext(deps);
  const relays = await client.listRelays();

  info(`Found ${relays.length} active relay(s).`);
  table(
    ['Relay ID', 'Region', 'Fee (bps)', 'Stake (SUI)', 'Routed', 'Fees Earned (SUI)', 'Endpoint'],
    relays.map((relay) => summarizeRelay(relay)),
  );
  return 0;
}

async function heartbeatRelay(args: string[], deps: RelayRegistryCommandDeps): Promise<number> {
  const relayId = readRequiredFlag(args, '--relay-id');
  const { client, keypair } = loadRelayContext(deps);
  const result = await client.heartbeat({ relayId, signer: keypair });

  success('Relay heartbeat submitted.');
  console.log(`Last Heartbeat: ${new Date(result.lastHeartbeat).toISOString()}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function deactivateRelay(args: string[], deps: RelayRegistryCommandDeps): Promise<number> {
  const relayId = readRequiredFlag(args, '--relay-id');
  const { client, keypair } = loadRelayContext(deps);
  const result = await client.deactivateRelay({ relayId, signer: keypair });

  success('Relay deactivated.');
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

function loadRelayContext(deps: RelayRegistryCommandDeps): {
  config: MeshCliConfig;
  keypair: Ed25519Keypair;
  client: Pick<RelayRegistryClient, 'registerRelay' | 'listRelays' | 'heartbeat' | 'deactivateRelay'>;
} {
  const config = (deps.loadConfig ?? loadMeshConfig)();
  if (!config.network.packageId) {
    throw new Error('network.packageId must be configured before using relay registry commands.');
  }

  const identity = (deps.loadKeypair ?? loadOrCreateKeypair)(config.identity.dataDir);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const client = deps.createClient?.(config) ?? new RelayRegistryClient(new MeshSuiClient(config.network), config.network);
  return { config, keypair, client };
}

function readRequiredFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : '';
  if (!value) {
    throw new Error(`Missing required flag ${flag}.`);
  }
  return value;
}

function readCapabilities(args: string[]): string[] {
  const index = args.indexOf('--capabilities');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    return ['routing'];
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : ['routing'];
}

function summarizeRelay(relay: RelayNode): string[] {
  return [
    relay.id,
    relay.region,
    relay.routingFeeBps.toString(),
    relay.stakeAmountMist !== undefined ? formatMistToSui(relay.stakeAmountMist) : '-',
    relay.totalRouted.toString(),
    formatMistToSui(relay.totalFeesEarnedMist),
    relay.endpoint,
  ];
}
