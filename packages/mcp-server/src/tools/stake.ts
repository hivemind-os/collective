import { StakingClient, STAKING_COOLDOWN_MS } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

export interface MeshStakeParams {
  action: 'deposit' | 'status' | 'withdraw';
  amount_sui?: string;
  stake_type?: 'agent' | 'relay';
}

export const meshStakeTool = {
  name: 'mesh_stake',
  description: 'Manage stake deposits, status, and withdrawals for the local Agentic Mesh identity',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['deposit', 'status', 'withdraw'] },
      amount_sui: { type: 'string', description: 'SUI amount to deposit when action=deposit' },
      stake_type: { type: 'string', enum: ['agent', 'relay'], description: 'Stake type for deposits (default agent)' },
    },
    required: ['action'],
  },
};

export async function runMeshStake(params: MeshStakeParams, context: MeshToolContext): Promise<Record<string, unknown>> {
  const client = context.stakingClient ?? new StakingClient(context.suiClient, context.networkConfig);
  const owner = context.keypair.getPublicKey().toSuiAddress();

  switch (params.action) {
    case 'deposit': {
      if (!params.amount_sui) {
        throw new Error('amount_sui is required when action=deposit');
      }
      const amountMist = parseSuiToMist(params.amount_sui);
      const result = await client.depositStake({
        amountMist,
        stakeType: params.stake_type ?? 'agent',
        signer: context.keypair as never,
      });
      return {
        action: 'deposit',
        stake_id: result.stakeId,
        tx_digest: result.txDigest,
        amount_mist: amountMist.toString(),
        amount_sui: params.amount_sui,
        stake_type: params.stake_type ?? 'agent',
      };
    }
    case 'status': {
      const stake = await client.getStakeByOwner(owner);
      return {
        action: 'status',
        owner,
        staked: Boolean(stake),
        stake,
      };
    }
    case 'withdraw': {
      const stake = await client.getStakeByOwner(owner);
      if (!stake) {
        throw new Error('No stake position found for this wallet.');
      }
      if (stake.deactivatedAt === 0) {
        const result = await client.startDeactivation({ stakeId: stake.id, signer: context.keypair as never });
        return {
          action: 'deactivation_started',
          stake_id: stake.id,
          cooldown_ends_at: result.cooldownEndsAt,
          tx_digest: result.txDigest,
        };
      }

      const cooldownEndsAt = stake.deactivatedAt + STAKING_COOLDOWN_MS;
      if (Date.now() < cooldownEndsAt) {
        return {
          action: 'cooling_down',
          stake_id: stake.id,
          cooldown_ends_at: cooldownEndsAt,
          cooldown_remaining_ms: Math.max(cooldownEndsAt - Date.now(), 0),
        };
      }

      const result = await client.withdrawStake({ stakeId: stake.id, signer: context.keypair as never });
      return {
        action: 'withdrawn',
        stake_id: stake.id,
        amount_returned_mist: result.amountReturned.toString(),
        tx_digest: result.txDigest,
      };
    }
    default:
      throw new Error(`Unknown staking action: ${String(params.action)}`);
  }
}

function parseSuiToMist(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(trimmed)) {
    throw new Error(`Invalid SUI amount: ${input}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}
