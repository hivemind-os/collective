import { loadOrCreateKeypair, MeshSuiClient, StakingClient, STAKING_COOLDOWN_MS } from '@hivemind-os/collective-core';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadMeshConfig, type MeshCliConfig } from './config.js';
import { formatMistToSui, parseSuiToMist } from './wallet.js';
import { info, success, table, warn } from '../utils/output.js';

export interface StakeCommandDeps {
  loadConfig?: () => MeshCliConfig;
  loadKeypair?: (dataDir: string) => { secretKey: Uint8Array };
  createClient?: (config: MeshCliConfig) => Pick<
    StakingClient,
    'depositStake' | 'getStakeByOwner' | 'startDeactivation' | 'withdrawStake'
  >;
}

export async function handleStake(subcommand?: string, args: string[] = [], deps: StakeCommandDeps = {}): Promise<number> {
  switch (subcommand) {
    case 'deposit':
      return await depositStake(args, deps);
    case 'status':
      return await showStakeStatus(deps);
    case 'withdraw':
      return await withdrawStake(args, deps);
    default:
      throw new Error('Usage: mesh stake <deposit|status|withdraw>');
  }
}

async function depositStake(args: string[], deps: StakeCommandDeps): Promise<number> {
  const amount = args[0];
  if (!amount) {
    throw new Error('Usage: mesh stake deposit <amount-sui> [--type agent|relay]');
  }

  const stakeType = readStakeType(args.slice(1));
  const amountMist = parseSuiToMist(amount);
  const { client, keypair } = loadStakeContext(deps);
  const result = await client.depositStake({ amountMist, stakeType, signer: keypair });

  success(`Deposited ${amount} SUI as ${stakeType} stake.`);
  console.log(`Stake ID: ${result.stakeId}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

async function showStakeStatus(deps: StakeCommandDeps): Promise<number> {
  const { client, keypair } = loadStakeContext(deps);
  const owner = keypair.getPublicKey().toSuiAddress();
  const stake = await client.getStakeByOwner(owner);
  if (!stake) {
    info('No stake position found for this wallet.');
    return 0;
  }

  const cooldownEndsAt = stake.deactivatedAt > 0 ? stake.deactivatedAt + STAKING_COOLDOWN_MS : 0;
  success(`Stake position ${stake.id}`);
  table(
    ['Field', 'Value'],
    [
      ['Owner', stake.owner],
      ['Type', stake.stakeType],
      ['Balance (SUI)', formatMistToSui(stake.balanceMist)],
      ['Balance (MIST)', stake.balanceMist.toString()],
      ['Active', String(stake.isActive ?? false)],
      ['Meets Minimum', String(stake.meetsMinium ?? false)],
      ['Slashed (SUI)', formatMistToSui(stake.slashedAmount)],
      ['Staked At', new Date(stake.stakedAt).toISOString()],
      ['Deactivated At', stake.deactivatedAt > 0 ? new Date(stake.deactivatedAt).toISOString() : '-'],
      ['Cooldown Ends', cooldownEndsAt > 0 ? new Date(cooldownEndsAt).toISOString() : '-'],
    ],
  );
  return 0;
}

async function withdrawStake(args: string[], deps: StakeCommandDeps): Promise<number> {
  void args;
  const { client, keypair } = loadStakeContext(deps);
  const owner = keypair.getPublicKey().toSuiAddress();
  const stake = await client.getStakeByOwner(owner);
  if (!stake) {
    throw new Error('No stake position found for this wallet.');
  }

  if (stake.deactivatedAt === 0) {
    const result = await client.startDeactivation({ stakeId: stake.id, signer: keypair });
    info('Stake deactivation started.');
    console.log(`Cooldown ends: ${new Date(result.cooldownEndsAt).toISOString()}`);
    console.log(`Tx Digest: ${result.txDigest}`);
    return 0;
  }

  const cooldownEndsAt = stake.deactivatedAt + STAKING_COOLDOWN_MS;
  if (Date.now() < cooldownEndsAt) {
    warn(`Cooldown still active until ${new Date(cooldownEndsAt).toISOString()}.`);
    return 1;
  }

  const result = await client.withdrawStake({ stakeId: stake.id, signer: keypair });
  success('Stake withdrawn.');
  console.log(`Returned (SUI): ${formatMistToSui(result.amountReturned)}`);
  console.log(`Returned (MIST): ${result.amountReturned.toString()}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

function loadStakeContext(deps: StakeCommandDeps): {
  config: MeshCliConfig;
  keypair: Ed25519Keypair;
  client: Pick<StakingClient, 'depositStake' | 'getStakeByOwner' | 'startDeactivation' | 'withdrawStake'>;
} {
  const config = (deps.loadConfig ?? loadMeshConfig)();
  if (!config.network.packageId) {
    throw new Error('network.packageId must be configured before staking.');
  }

  const identity = (deps.loadKeypair ?? ((dir: string) => loadOrCreateKeypair(dir, { allowInsecureFileStorage: true })))(config.identity.dataDir);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const client = deps.createClient?.(config) ?? new StakingClient(new MeshSuiClient(config.network), config.network);
  return { config, keypair, client };
}

function readStakeType(args: string[]): 'agent' | 'relay' {
  const typeFlagIndex = args.indexOf('--type');
  if (typeFlagIndex >= 0) {
    const value = args[typeFlagIndex + 1]?.trim().toLowerCase();
    if (value === 'agent' || value === 'relay') {
      return value;
    }
    throw new Error('Usage: mesh stake deposit <amount-sui> [--type agent|relay]');
  }
  return 'agent';
}
