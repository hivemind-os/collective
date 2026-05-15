import { describe, expect, it } from 'vitest';

import { UsageMeter } from '../../src/metering/meter.js';

describe('UsageMeter', () => {
  it('tracks usage and computes capped cost', () => {
    const meter = new UsageMeter({ taskId: 'task-1', maxPrice: 500n, unitPrice: 300n });

    meter.recordUnit(new TextEncoder().encode('a'));
    meter.recordUnit(new TextEncoder().encode('b'));

    expect(meter.getActualUnits()).toBe(2);
    expect(meter.getCost()).toBe(500n);
    expect(meter.getReport()).toEqual({
      taskId: 'task-1',
      actualUnits: 2,
      actualCost: 500n,
      maxPrice: 500n,
      refundAmount: 0n,
      verificationHash: meter.getVerificationHash(),
    });
  });
});
