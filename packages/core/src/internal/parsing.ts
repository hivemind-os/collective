import { PaymentRail, TaskStatus, type AgentCard, type Capability, type Task } from '@agentic-mesh/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringToBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return decoder.decode(value);
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return decoder.decode(new Uint8Array(value));
  }

  return '';
}

export function bytesToHex(value: Uint8Array | number[]): string {
  return Buffer.from(value).toString('hex');
}

export function normalizeMoveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMoveValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.id === 'string' && Object.keys(value).length === 1) {
    return value.id;
  }

  if (isRecord(value.fields)) {
    return normalizeMoveValue(value.fields);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeMoveValue(entry)]),
  );
}

export function normalizeObjectOwner(owner: unknown): string | undefined {
  if (!isRecord(owner)) {
    return undefined;
  }

  if (typeof owner.AddressOwner === 'string') {
    return owner.AddressOwner;
  }

  if (typeof owner.ObjectOwner === 'string') {
    return owner.ObjectOwner;
  }

  return undefined;
}

function getValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string' && value.length > 0) {
    return Number(value);
  }

  return fallback;
}

function asBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    return BigInt(value);
  }

  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }

  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeCapability(raw: unknown): Capability {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const amount = asBigInt(getValue(record, 'price_mist', 'priceMist', 'amount'));

  return {
    name: asString(getValue(record, 'name')),
    description: asString(getValue(record, 'description')),
    version: asString(getValue(record, 'version')),
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount,
      currency: asString(getValue(record, 'currency'), 'MIST'),
    },
  };
}

export function parseAgentCardFields(raw: unknown, fallbackId?: string): AgentCard {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const capabilitiesValue = getValue(record, 'capabilities');
  const capabilities = Array.isArray(capabilitiesValue)
    ? capabilitiesValue.map((entry) => normalizeCapability(entry))
    : [];

  return {
    id: asString(getValue(record, 'id', 'card_id', 'cardId', 'objectId'), fallbackId ?? ''),
    owner: asString(getValue(record, 'owner', 'agent', 'objectOwner')),
    did: asString(getValue(record, 'did')) as AgentCard['did'],
    name: asString(getValue(record, 'name')),
    description: asString(getValue(record, 'description')),
    capabilities,
    endpoint: asString(getValue(record, 'endpoint')) || undefined,
    active: asBoolean(getValue(record, 'active'), true),
    version: asNumber(getValue(record, 'version'), 1),
    registeredAt: asNumber(getValue(record, 'registered_at', 'registeredAt')),
    updatedAt: asNumber(getValue(record, 'updated_at', 'updatedAt')),
  };
}

function normalizeOptionalAddress(value: unknown): string | undefined {
  const address = asString(value);
  return address.length === 0 || /^0x0+$/i.test(address) ? undefined : address;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = bytesToString(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function parseTaskFields(raw: unknown, fallbackId?: string): Task {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const status = asNumber(getValue(record, 'status'), TaskStatus.OPEN) as TaskStatus;
  const acceptedAt = asNumber(getValue(record, 'accepted_at', 'acceptedAt'));
  const completedAt = asNumber(getValue(record, 'completed_at', 'completedAt'));

  return {
    id: asString(getValue(record, 'id', 'task_id', 'taskId', 'objectId'), fallbackId ?? ''),
    requester: asString(getValue(record, 'requester')),
    provider: normalizeOptionalAddress(getValue(record, 'provider')),
    capability: asString(getValue(record, 'capability')),
    inputBlobId: bytesToString(getValue(record, 'input_blob_id', 'inputBlobId')),
    resultBlobId: normalizeOptionalString(getValue(record, 'result_blob_id', 'resultBlobId')),
    price: asBigInt(getValue(record, 'price')),
    status,
    disputeWindowMs: asNumber(getValue(record, 'dispute_window_ms', 'disputeWindowMs')),
    createdAt: asNumber(getValue(record, 'created_at', 'createdAt')),
    acceptedAt: acceptedAt > 0 ? acceptedAt : undefined,
    completedAt: completedAt > 0 ? completedAt : undefined,
    expiresAt: asNumber(getValue(record, 'expires_at', 'expiresAt')),
    agreementHash: normalizeOptionalString(getValue(record, 'agreement_hash', 'agreementHash')),
  };
}
