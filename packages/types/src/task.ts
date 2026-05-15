import type { TaskCategory } from './marketplace.js';

export enum TaskStatus {
  OPEN = 0,
  ACCEPTED = 1,
  COMPLETED = 2,
  RELEASED = 3,
  DISPUTED = 4,
  CANCELLED = 5,
}

export interface TaskInput {
  blobId: string;
  contentType?: string;
  encoding?: string;
  checksum?: string;
  sizeBytes?: number;
  metadata?: Record<string, string>;
}

export interface TaskResult {
  blobId: string;
  contentType?: string;
  encoding?: string;
  checksum?: string;
  sizeBytes?: number;
  metadata?: Record<string, string>;
}

export interface EscrowInfo {
  amount: bigint;
  disputeWindowMs: number;
  createdAt: number;
  expiresAt: number;
  releasedAt?: number;
  disputedAt?: number;
}

export interface Task {
  id: string;
  requester: string;
  provider?: string;
  capability: string;
  category: TaskCategory;
  inputBlobId: string;
  resultBlobId?: string;
  price: bigint;
  status: TaskStatus;
  disputeWindowMs: number;
  createdAt: number;
  acceptedAt?: number;
  completedAt?: number;
  expiresAt: number;
  agreementHash?: string;
}
