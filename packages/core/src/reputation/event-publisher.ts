import { randomBytes, randomUUID } from 'node:crypto';

import type { ReputationEvent, ReputationEventType } from '@hivemind-os/collective-types';

import type { AuthProvider } from '../auth/types.js';
import type { BlobStore } from '../blobstore/interface.js';

import { serializeReputationEvent, serializeReputationEventPayload } from './serialization.js';
import { assertValidReputationEvent } from './validation.js';

export class ReputationEventPublisher {
  constructor(
    private readonly blobStore: BlobStore,
    private readonly identity: AuthProvider,
  ) {}

  async createEvent(params: {
    type: ReputationEventType;
    subject: string;
    taskId: string;
    outcome: string;
    capability: string;
    rating?: number;
    latencyMs?: number;
    paymentAmount?: { amount: string; currency: string };
  }): Promise<ReputationEvent> {
    const unsignedEvent = {
      eventId: `rep_evt_${randomUUID().replace(/-/g, '')}`,
      type: params.type,
      subject: params.subject,
      author: this.identity.getDID(),
      taskId: params.taskId,
      outcome: normalizeOutcome(params.outcome),
      rating: params.rating,
      capability: params.capability,
      paymentAmount: params.paymentAmount,
      latencyMs: params.latencyMs,
      timestamp: new Date().toISOString(),
      nonce: randomBytes(16).toString('hex'),
    } satisfies Omit<ReputationEvent, 'signature'>;

    const signed = await this.identity.signPersonalMessage(serializeReputationEventPayload(unsignedEvent));
    return assertValidReputationEvent({
      ...unsignedEvent,
      signature: Buffer.from(signed.signature).toString('base64'),
    });
  }

  async publishEvent(event: ReputationEvent): Promise<void> {
    await this.blobStore.store(serializeReputationEvent(event));
  }
}

function normalizeOutcome(outcome: string): ReputationEvent['outcome'] {
  switch (outcome) {
    case 'success':
    case 'failure':
    case 'timeout':
    case 'cancelled':
    case 'disputed':
      return outcome;
    default:
      throw new Error(`Unsupported reputation outcome: ${outcome}`);
  }
}
