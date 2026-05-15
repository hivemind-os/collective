import { describe, expect, it, vi } from 'vitest';

import type { MeshToolContext } from '../src/context.js';
import { formatMistToSui, runMeshBalance } from '../src/tools/balance.js';

describe('runMeshBalance', () => {
  it('returns the correct balance payload', async () => {
    const context = {
      keypair: {
        getPublicKey: () => ({
          toSuiAddress: () => '0xabc',
        }),
      },
      suiClient: {
        getBalance: vi.fn().mockResolvedValue(1_500_000_000n),
      },
    } as unknown as MeshToolContext;

    const result = await runMeshBalance({}, context);

    expect(result).toEqual({
      address: '0xabc',
      balance_mist: '1500000000',
      balance_sui: '1.5',
    });
  });

  it('formats MIST into SUI correctly', () => {
    expect(formatMistToSui(2_000_000_000n)).toBe('2');
    expect(formatMistToSui(123_456_789n)).toBe('0.123456789');
  });
});
