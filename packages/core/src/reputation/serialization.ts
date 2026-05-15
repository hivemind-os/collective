import type { ReputationEvent } from '@agentic-mesh/types';

const encoder = new TextEncoder();

export type UnsignedReputationEvent = Omit<ReputationEvent, 'signature'>;

export function serializeReputationEventPayload(event: UnsignedReputationEvent): Uint8Array {
  return encoder.encode(JSON.stringify(toSerializableUnsignedEvent(event)));
}

export function serializeReputationEvent(event: ReputationEvent): Uint8Array {
  return encoder.encode(JSON.stringify(toSerializableEvent(event)));
}

function toSerializableUnsignedEvent(event: UnsignedReputationEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    type: event.type,
    subject: event.subject,
    author: event.author,
    taskId: event.taskId,
    outcome: event.outcome,
    rating: event.rating,
    capability: event.capability,
    paymentAmount: event.paymentAmount,
    latencyMs: event.latencyMs,
    timestamp: event.timestamp,
    nonce: event.nonce,
  };
}

function toSerializableEvent(event: ReputationEvent): Record<string, unknown> {
  return {
    ...toSerializableUnsignedEvent(event),
    signature: event.signature,
  };
}
