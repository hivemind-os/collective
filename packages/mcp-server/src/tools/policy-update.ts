import { PaymentRail, type SpendingPolicy } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';

export interface MeshPolicyUpdateParams {
  daily_limit_mist?: number;
  monthly_limit_mist?: number;
  per_task_limit_mist?: number;
}

export const meshPolicyUpdateTool = {
  name: 'collective_policy_update',
  description: 'Update local spending policy limits',
  inputSchema: {
    type: 'object' as const,
    properties: {
      daily_limit_mist: { type: 'number', description: 'Daily MIST limit' },
      monthly_limit_mist: { type: 'number', description: 'Monthly MIST limit' },
      per_task_limit_mist: { type: 'number', description: 'Per-task MIST limit' },
    },
    required: [],
  },
};

export async function runMeshPolicyUpdate(
  params: MeshPolicyUpdateParams,
  context: MeshToolContext,
): Promise<{
  updated: true;
  limits: Array<{ interval: string; amount_mist: string; rail: string }>;
}> {
  const currentPolicy = clonePolicy(readPolicySnapshot(context));
  const nextLimits = [...currentPolicy.limits];

  applyLimit(nextLimits, 'transaction', params.per_task_limit_mist);
  applyLimit(nextLimits, 'day', params.daily_limit_mist);
  applyLimit(nextLimits, 'month', params.monthly_limit_mist);

  const updatedPolicy: SpendingPolicy = {
    ...currentPolicy,
    limits: nextLimits,
  };

  context.spendingPolicy.updatePolicy(updatedPolicy);

  return {
    updated: true,
    limits: updatedPolicy.limits.map((limit) => ({
      interval: limit.interval,
      amount_mist: limit.amount.toString(),
      rail: limit.rail ?? PaymentRail.SUI_ESCROW,
    })),
  };
}

export function readPolicySnapshot(context: MeshToolContext): SpendingPolicy {
  return context.spendingPolicy.getCurrentPolicy();
}

function clonePolicy(policy: SpendingPolicy): SpendingPolicy {
  return {
    ...policy,
    limits: policy.limits.map((limit) => ({ ...limit })),
    allowlist: policy.allowlist ? [...policy.allowlist] : undefined,
    denylist: policy.denylist ? [...policy.denylist] : undefined,
  };
}

export function applyLimit(
  limits: SpendingPolicy['limits'],
  interval: 'transaction' | 'day' | 'month',
  amount?: number,
): void {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return;
  }
  if (amount < 0) {
    throw new Error(`Spending limit for '${interval}' must be non-negative. Got: ${amount}`);
  }
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Spending limit for '${interval}' exceeds maximum safe integer. Got: ${amount}`);
  }

  const nextLimit = {
    amount: BigInt(Math.floor(amount)),
    interval,
    rail: PaymentRail.SUI_ESCROW,
  } as const;
  const index = limits.findIndex(
    (entry) => entry.interval === interval && (entry.rail ?? PaymentRail.SUI_ESCROW) === PaymentRail.SUI_ESCROW,
  );

  if (index >= 0) {
    limits[index] = nextLimit;
    return;
  }

  limits.push(nextLimit);
}
