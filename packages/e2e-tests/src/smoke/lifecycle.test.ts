import { describe, expect, it } from 'vitest';

import {
  PortAllocator,
  ProcessTracker,
  SUI_STARTUP_TIMEOUT,
  SuiTestNetwork,
} from '../harness/index.js';

describe('lifecycle smoke scaffold', () => {
  it('exposes the local Sui test harness primitives', () => {
    const network = new SuiTestNetwork({
      portAllocator: new PortAllocator(),
      processTracker: new ProcessTracker(),
    });

    expect(SUI_STARTUP_TIMEOUT).toBe(30000);
    expect(network).toBeInstanceOf(SuiTestNetwork);
  });
});
