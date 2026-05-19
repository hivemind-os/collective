import { describe, expect, it, vi } from 'vitest';

import { PaymentRail, type SpendingPolicy } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../src/context.js';
import { applyLimit, readPolicySnapshot, runMeshPolicyUpdate } from '../src/tools/policy-update.js';

describe('policy update helpers', () => {
  it('reads the current policy via the spending policy getter', () => {
    const policy: SpendingPolicy = {
      limits: [{ amount: 10n, interval: 'day', rail: PaymentRail.SUI_ESCROW }],
      allowlist: ['app-1'],
    };
    const getCurrentPolicy = vi.fn(() => policy);

    expect(
      readPolicySnapshot({
        spendingPolicy: { getCurrentPolicy },
      } as unknown as MeshToolContext),
    ).toEqual(policy);
    expect(getCurrentPolicy).toHaveBeenCalledOnce();
  });

  it('preserves the existing policy when updating limits', async () => {
    const currentPolicy: SpendingPolicy = {
      limits: [{ amount: 100n, interval: 'month', rail: PaymentRail.SUI_ESCROW }],
      allowlist: ['app-1'],
    };
    const getCurrentPolicy = vi.fn(() => currentPolicy);
    const updatePolicy = vi.fn();

    await runMeshPolicyUpdate(
      { daily_limit_mist: 25 },
      {
        spendingPolicy: { getCurrentPolicy, updatePolicy },
      } as unknown as MeshToolContext,
    );

    expect(updatePolicy).toHaveBeenCalledWith({
      allowlist: ['app-1'],
      limits: [
        { amount: 100n, interval: 'month', rail: PaymentRail.SUI_ESCROW },
        { amount: 25n, interval: 'day', rail: PaymentRail.SUI_ESCROW },
      ],
    });
  });

  it('ignores non-finite amounts', () => {
    const limits: SpendingPolicy['limits'] = [];

    applyLimit(limits, 'day', Number.POSITIVE_INFINITY);

    expect(limits).toEqual([]);
  });

  it.each([-1, -0.5])('rejects negative amounts: %s', (amount) => {
    expect(() => applyLimit([], 'transaction', amount)).toThrow(/must be non-negative/);
  });

  it('rejects amounts above the maximum safe integer', () => {
    expect(() => applyLimit([], 'month', Number.MAX_SAFE_INTEGER + 1)).toThrow(/exceeds maximum safe integer/);
  });
});
