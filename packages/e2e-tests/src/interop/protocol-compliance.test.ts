import { createDID, parseDID, parseRawEvent } from '@agentic-mesh/core';
import { RelayNodeStatus } from '@agentic-mesh/types';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, createRelayRegisteredEvent, isProtocolVersionCompatible } from './test-helpers.js';

describe('interop protocol compliance', () => {
  it('keeps the frozen 1.0.0 protocol version compatible', () => {
    expect(PROTOCOL_VERSION).toBe('1.0.0');
    expect(isProtocolVersionCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it('round-trips did:mesh identities', () => {
    const publicKey = new Uint8Array(32).fill(7);
    const did = createDID(publicKey);

    expect(parseDID(did).publicKey).toEqual(publicKey);
  });

  it('parses relay registration events into the shared event schema', () => {
    const packageId = '0x42';
    const parsed = parseRawEvent(createRelayRegisteredEvent(packageId), packageId);

    expect(parsed).toMatchObject({
      type: 'relay.registered',
      packageId,
      relay: {
        endpoint: 'wss://relay.mesh.example/ws',
        region: 'us-east',
        status: RelayNodeStatus.ACTIVE,
        routingFeeBps: 50,
      },
    });
  });
});
