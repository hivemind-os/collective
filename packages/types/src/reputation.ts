export interface ReputationEvent {
  eventId: string;
  type: ReputationEventType;
  subject: string;
  author: string;
  taskId: string;
  outcome: 'success' | 'failure' | 'timeout' | 'cancelled' | 'disputed';
  rating?: number;
  capability: string;
  paymentAmount?: { amount: string; currency: string };
  latencyMs?: number;
  timestamp: string;
  nonce: string;
  signature: string;
}

export type ReputationEventType =
  | 'task_completion'
  | 'task_failure'
  | 'task_timeout'
  | 'task_cancellation'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'payment_confirmed';

export interface ReputationScore {
  did: string;
  successRate: number;
  totalTasks: number;
  totalDisputes: number;
  averageLatencyMs: number;
  totalEarningsMist: bigint;
  stakeAmount: bigint;
  registeredAt: number;
  lastActiveAt: number;
  capabilityScores: Record<string, {
    successRate: number;
    taskCount: number;
    averageLatencyMs: number;
  }>;
}

export interface ReputationAnchor {
  anchorId: string;
  author: string;
  merkleRoot: string;
  eventCount: number;
  blobId: string;
  fromTimestamp: number;
  toTimestamp: number;
}
