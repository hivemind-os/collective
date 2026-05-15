import type { ReputationEvent, ReputationEventType } from '@agentic-mesh/types';

const EVENT_TYPES = new Set<ReputationEventType>([
  'task_completion',
  'task_failure',
  'task_timeout',
  'task_cancellation',
  'dispute_opened',
  'dispute_resolved',
  'payment_confirmed',
]);

const OUTCOMES = new Set<ReputationEvent['outcome']>([
  'success',
  'failure',
  'timeout',
  'cancelled',
  'disputed',
]);

export function assertValidReputationEvent(event: ReputationEvent): ReputationEvent {
  return parseReputationEvent(event);
}

export function parseReputationEvent(value: unknown): ReputationEvent {
  if (!isRecord(value)) {
    throw new Error('Reputation event must be an object.');
  }

  const event = {
    eventId: parseRequiredString(value.eventId, 'eventId'),
    type: parseEventType(value.type),
    subject: parseDid(value.subject, 'subject'),
    author: parseDid(value.author, 'author'),
    taskId: parseRequiredString(value.taskId, 'taskId'),
    outcome: parseOutcome(value.outcome),
    rating: parseOptionalRating(value.rating),
    capability: parseRequiredString(value.capability, 'capability'),
    paymentAmount: parseOptionalPaymentAmount(value.paymentAmount),
    latencyMs: parseOptionalLatencyMs(value.latencyMs),
    timestamp: parseTimestamp(value.timestamp),
    nonce: parseRequiredString(value.nonce, 'nonce'),
    signature: parseRequiredString(value.signature, 'signature'),
  } satisfies ReputationEvent;

  if (event.subject === event.author) {
    throw new Error('Reputation event subject must differ from author.');
  }

  return event;
}

function parseEventType(value: unknown): ReputationEventType {
  if (typeof value === 'string' && EVENT_TYPES.has(value as ReputationEventType)) {
    return value as ReputationEventType;
  }
  throw new Error(`Unsupported reputation event type: ${String(value)}`);
}

function parseOutcome(value: unknown): ReputationEvent['outcome'] {
  if (typeof value === 'string' && OUTCOMES.has(value as ReputationEvent['outcome'])) {
    return value as ReputationEvent['outcome'];
  }
  throw new Error(`Unsupported reputation outcome: ${String(value)}`);
}

function parseDid(value: unknown, field: string): string {
  const did = parseRequiredString(value, field);
  if (!did.startsWith('did:mesh:') || did.length <= 'did:mesh:'.length) {
    throw new Error(`${field} must be a valid did:mesh identifier.`);
  }
  return did;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function parseOptionalRating(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 5) {
    throw new Error('rating must be an integer between 1 and 5.');
  }
  return value as number;
}

function parseOptionalLatencyMs(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('latencyMs must be a non-negative safe integer.');
  }
  return value as number;
}

function parseOptionalPaymentAmount(value: unknown): ReputationEvent['paymentAmount'] {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('paymentAmount must be an object when provided.');
  }

  const amount = parseRequiredString(value.amount, 'paymentAmount.amount');
  if (!/^\d+$/.test(amount)) {
    throw new Error('paymentAmount.amount must be a non-negative integer string.');
  }

  return {
    amount,
    currency: parseRequiredString(value.currency, 'paymentAmount.currency'),
  };
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseRequiredString(value, 'timestamp');
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error('timestamp must be a valid ISO-8601 string.');
  }
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
