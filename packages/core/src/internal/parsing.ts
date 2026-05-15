import { BidStatus, PaymentRail, TaskStatus, type AgentCard, type Bid, type Capability, type Dispute, type StakePosition, type Task } from '@agentic-mesh/types';

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
  const railsValue = getValue(record, 'paymentRails', 'payment_rails');
  const paymentRails = Array.isArray(railsValue)
    ? railsValue.filter((entry): entry is PaymentRail => typeof entry === 'string' && Object.values(PaymentRail).includes(entry as PaymentRail))
    : undefined;

  return {
    name: asString(getValue(record, 'name')),
    description: asString(getValue(record, 'description')),
    version: asString(getValue(record, 'version')),
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount,
      currency: asString(getValue(record, 'currency'), 'MIST'),
    },
    executionMode: asExecutionMode(getValue(record, 'executionMode', 'execution_mode')),
    paymentRails,
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
    relayEndpoints: normalizeRelayEndpoints(getValue(record, 'relayEndpoints', 'relay_endpoints')),
    encryptionPublicKey: normalizeOptionalHex(getValue(record, 'encryption_public_key', 'encryptionPublicKey')),
    active: asBoolean(getValue(record, 'active'), true),
    version: asNumber(getValue(record, 'version'), 1),
    registeredAt: asNumber(getValue(record, 'registered_at', 'registeredAt')),
    updatedAt: asNumber(getValue(record, 'updated_at', 'updatedAt')),
    totalTasksCompleted: normalizeOptionalNumber(getValue(record, 'total_tasks_completed', 'totalTasksCompleted')),
    totalTasksFailed: normalizeOptionalNumber(getValue(record, 'total_tasks_failed', 'totalTasksFailed')),
    totalTasksDisputed: normalizeOptionalNumber(getValue(record, 'total_tasks_disputed', 'totalTasksDisputed')),
    totalEarningsMist: normalizeOptionalBigInt(getValue(record, 'total_earnings_mist', 'totalEarningsMist')),
    hasStake: normalizeOptionalBoolean(getValue(record, 'has_stake', 'hasStake')),
    stakeMist: normalizeOptionalBigInt(getValue(record, 'stake_mist', 'stakeMist')),
    stakeType: normalizeStakeType(getValue(record, 'stake_type', 'stakeType')),
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

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return asNumber(value);
}

function normalizeOptionalBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return asBigInt(value);
}

function normalizeOptionalHex(value: unknown): string | undefined {
  const normalized = bytesToOptionalHex(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeRelayEndpoints(value: unknown): AgentCard['relayEndpoints'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const relayEndpoints = value
    .map((entry) => {
      const record = isRecord(entry) ? (normalizeMoveValue(entry) as Record<string, unknown>) : null;
      const endpoint = record ? asString(getValue(record, 'endpoint', 'url', 'serviceEndpoint')) : '';
      if (!endpoint) {
        return null;
      }

      return {
        relayDid: asString(getValue(record, 'relayDid', 'relay_did')) as AgentCard['did'] | undefined,
        endpoint,
        modes: Array.isArray(record?.modes)
          ? record.modes.filter(
              (mode): mode is NonNullable<NonNullable<AgentCard['relayEndpoints']>[number]['modes']>[number] =>
                typeof mode === 'string',
            )
          : undefined,
      };
    })
    .filter((entry): entry is NonNullable<AgentCard['relayEndpoints']>[number] => Boolean(entry));

  return relayEndpoints.length > 0 ? relayEndpoints : undefined;
}

function bytesToOptionalHex(value: unknown): string {
  if (typeof value === 'string' && /^[a-f0-9]+$/i.test(value) && value.length % 2 === 0) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return bytesToHex(value);
  }

  return '';
}

function asExecutionMode(value: unknown): Capability['executionMode'] {
  return value === 'sync' || value === 'async' ? value : undefined;
}

function normalizeStakeType(value: unknown): StakePosition['stakeType'] | AgentCard['stakeType'] | undefined {
  if (value === 0 || value === '0' || value === 'agent') {
    return 'agent';
  }
  if (value === 1 || value === '1' || value === 'relay') {
    return 'relay';
  }
  return undefined;
}

function normalizeBalanceValue(value: unknown): bigint {
  if (isRecord(value)) {
    return asBigInt(getValue(value, 'value'));
  }
  return asBigInt(value);
}

export function parseStakePositionFields(raw: unknown, fallbackId?: string): StakePosition {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const balanceValue = getValue(record, 'balance', 'balanceMist', 'balance_mist');
  const deactivatedAt = asNumber(getValue(record, 'deactivated_at', 'deactivatedAt'));
  const balanceMist = normalizeBalanceValue(balanceValue);
  const stakeType = normalizeStakeType(getValue(record, 'stake_type', 'stakeType')) ?? 'agent';
  const meetsMinimum = stakeType === 'relay' ? balanceMist >= 100_000_000_000n : balanceMist >= 10_000_000_000n;
  const isActive = deactivatedAt === 0 && meetsMinimum;

  return {
    id: asString(getValue(record, 'id', 'stake_id', 'stakeId', 'objectId'), fallbackId ?? ''),
    owner: asString(getValue(record, 'owner', 'objectOwner')),
    stakeType,
    balanceMist,
    stakedAt: asNumber(getValue(record, 'staked_at', 'stakedAt')),
    deactivatedAt,
    slashedAmount: asBigInt(getValue(record, 'slashed_amount', 'slashedAmount')),
    isActive,
    meetsMinium: meetsMinimum,
    meetsMinimum,
  };
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
    category: asString(getValue(record, 'category'), 'general'),
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

export function parseBidFields(raw: unknown, fallbackId?: string): Bid {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const evidenceBlob = normalizeOptionalString(getValue(record, 'evidence_blob', 'evidenceBlob'));

  return {
    id: asString(getValue(record, 'id', 'bid_id', 'bidId', 'objectId'), fallbackId ?? ''),
    taskId: asString(getValue(record, 'task_id', 'taskId')),
    bidder: asString(getValue(record, 'bidder')),
    bidPrice: asBigInt(getValue(record, 'bid_price', 'bidPrice')),
    reputationScore: asBigInt(getValue(record, 'reputation_score', 'reputationScore')),
    evidenceBlob,
    createdAt: asNumber(getValue(record, 'created_at', 'createdAt')),
    status: asNumber(getValue(record, 'status'), BidStatus.ACTIVE) as BidStatus,
  };
}

export function parseDisputeFields(raw: unknown, fallbackId?: string): Dispute {
  const record = isRecord(raw) ? (normalizeMoveValue(raw) as Record<string, unknown>) : {};
  const respondedAt = asNumber(getValue(record, 'responded_at', 'respondedAt'));
  const resolvedAt = asNumber(getValue(record, 'resolved_at', 'resolvedAt'));

  return {
    id: asString(getValue(record, 'id', 'dispute_id', 'disputeId', 'objectId'), fallbackId ?? ''),
    taskId: asString(getValue(record, 'task_id', 'taskId')),
    requester: asString(getValue(record, 'requester')),
    provider: asString(getValue(record, 'provider')),
    escrowAmount: asBigInt(getValue(record, 'escrow_amount', 'escrowAmount')),
    status: asNumber(getValue(record, 'status')) as Dispute['status'],
    requesterEvidenceBlob: bytesToString(getValue(record, 'requester_evidence_blob', 'requesterEvidenceBlob')),
    providerEvidenceBlob: normalizeOptionalString(getValue(record, 'provider_evidence_blob', 'providerEvidenceBlob')),
    requesterProposedSplit: asBigInt(getValue(record, 'requester_proposed_split', 'requesterProposedSplit')),
    providerProposedSplit: asBigInt(getValue(record, 'provider_proposed_split', 'providerProposedSplit')),
    arbitrator: normalizeOptionalAddress(getValue(record, 'arbitrator')),
    rulingSplit: asBigInt(getValue(record, 'ruling_split', 'rulingSplit')),
    openedAt: asNumber(getValue(record, 'opened_at', 'openedAt')),
    respondedAt: respondedAt > 0 ? respondedAt : undefined,
    resolvedAt: resolvedAt > 0 ? resolvedAt : undefined,
    resolutionDeadline: asNumber(getValue(record, 'resolution_deadline', 'resolutionDeadline')),
  };
}
