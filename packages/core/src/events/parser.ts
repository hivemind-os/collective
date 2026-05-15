import { BidStatus, TaskStatus, type MeshEvent } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';

import { isRecord, parseAgentCardFields, parseBidFields, parseTaskFields } from '../internal/parsing.js';

export function parseRawEvent(rawEvent: SuiEvent, packageId: string): MeshEvent | null {
  if (!rawEvent.type.startsWith(`${packageId}::`)) {
    return null;
  }

  if (!isRecord(rawEvent.parsedJson)) {
    return null;
  }

  const payload = rawEvent.parsedJson;
  const timestampMs = Number(rawEvent.timestampMs ?? 0);
  const base = {
    packageId,
    txDigest: rawEvent.id.txDigest,
    timestampMs,
  };

  switch (rawEvent.type) {
    case `${packageId}::registry::AgentRegistered`: {
      const agent = parseAgentCardFields(payload);
      return {
        ...base,
        type: 'agent.registered',
        registryId: '',
        agent,
      };
    }
    case `${packageId}::registry::AgentUpdated`: {
      const agent = parseAgentCardFields(payload);
      return {
        ...base,
        type: 'agent.updated',
        agent,
        previousVersion: Math.max(agent.version - 1, 0),
      };
    }
    case `${packageId}::registry::AgentDeactivated`: {
      const agent = parseAgentCardFields(payload);
      return {
        ...base,
        type: 'agent.deactivated',
        agentId: agent.id,
        owner: agent.owner,
        deactivatedAt: timestampMs,
      };
    }
    case `${packageId}::task::TaskPosted`: {
      return {
        ...base,
        type: 'task.posted',
        task: parseTaskFields(payload),
      };
    }
    case `${packageId}::task::TaskAccepted`: {
      return {
        ...base,
        type: 'task.accepted',
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        provider: asString(payload.provider),
        acceptedAt: asNumber(payload.accepted_at, timestampMs),
        status: TaskStatus.ACCEPTED,
      };
    }
    case `${packageId}::task::TaskCompleted`: {
      return {
        ...base,
        type: 'task.completed',
        taskId: asString(payload.task_id, payload.taskId),
        provider: asString(payload.provider),
        resultBlobId: bytesToString(payload.result_blob_id ?? payload.resultBlobId),
        completedAt: asNumber(payload.completed_at, timestampMs),
        status: TaskStatus.COMPLETED,
      };
    }
    case `${packageId}::task::TaskPaymentReleased`: {
      return {
        ...base,
        type: 'task.released',
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        provider: asString(payload.provider),
        releasedAt: timestampMs,
        status: TaskStatus.RELEASED,
      };
    }
    case `${packageId}::task::TaskDisputed`: {
      return {
        ...base,
        type: 'task.disputed',
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        provider: asOptionalString(payload.provider),
        disputedAt: asNumber(payload.disputed_at, timestampMs),
        status: TaskStatus.DISPUTED,
      };
    }
    case `${packageId}::task::TaskCancelled`:
    case `${packageId}::task::TaskExpiredRefunded`: {
      return {
        ...base,
        type: 'task.cancelled',
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        cancelledAt: timestampMs,
        status: TaskStatus.CANCELLED,
      };
    }
    case `${packageId}::marketplace::BidPlaced`: {
      return {
        ...base,
        type: 'bid.placed',
        bid: parseBidFields(payload),
      };
    }
    case `${packageId}::marketplace::BidAccepted`: {
      return {
        ...base,
        type: 'bid.accepted',
        bidId: asString(payload.bid_id, payload.bidId),
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        bidder: asString(payload.bidder),
        bidPrice: asBigInt(payload.bid_price ?? payload.bidPrice),
        refundedAmount: asBigInt(payload.refunded_amount ?? payload.refundedAmount),
        acceptedAt: asNumber(payload.accepted_at, timestampMs),
        status: BidStatus.ACCEPTED,
      };
    }
    case `${packageId}::marketplace::BidWithdrawn`: {
      return {
        ...base,
        type: 'bid.withdrawn',
        bidId: asString(payload.bid_id, payload.bidId),
        taskId: asString(payload.task_id, payload.taskId),
        bidder: asString(payload.bidder),
        withdrawnAt: timestampMs,
        status: BidStatus.WITHDRAWN,
      };
    }
    case `${packageId}::marketplace::BidRejected`: {
      return {
        ...base,
        type: 'bid.rejected',
        bidId: asString(payload.bid_id, payload.bidId),
        taskId: asString(payload.task_id, payload.taskId),
        requester: asString(payload.requester),
        bidder: asString(payload.bidder),
        rejectedAt: timestampMs,
        status: BidStatus.REJECTED,
      };
    }
    default:
      return null;
  }
}

function asString(...values: unknown[]): string {
  const match = values.find((value) => typeof value === 'string');
  return typeof match === 'string' ? match : '';
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized.length > 0 ? normalized : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.length > 0) {
    return Number(value);
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  return fallback;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function bytesToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return new TextDecoder().decode(new Uint8Array(value));
  }

  return '';
}
