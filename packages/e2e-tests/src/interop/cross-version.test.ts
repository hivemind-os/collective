import { describe, expect, it } from 'vitest';

import { parseRawEvent } from '@agentic-mesh/core';

import {
  PROTOCOL_VERSION,
  createRelayRegisteredEvent,
  createRelayRegisteredEventV1_1,
  isProtocolVersionCompatible,
} from './test-helpers.js';

describe('interop cross-version compatibility', () => {
  it('accepts additive 1.x protocol versions', () => {
    expect(isProtocolVersionCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolVersionCompatible('1.1.0')).toBe(true);
    expect(isProtocolVersionCompatible('2.0.0')).toBe(false);
  });

  it('parses relay registration events from both snake_case and camelCase payloads', () => {
    const packageId = '0x99';
    const v1 = parseRawEvent(createRelayRegisteredEvent(packageId, { region: 'us-east' }), packageId);
    const v11 = parseRawEvent(createRelayRegisteredEventV1_1(packageId, { region: 'eu-west' }), packageId);

    expect(v1).toMatchObject({ type: 'relay.registered', relay: { region: 'us-east' } });
    expect(v11).toMatchObject({ type: 'relay.registered', relay: { region: 'eu-west' } });
  });
});
