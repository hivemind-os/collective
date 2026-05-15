import type { AgentCard } from './agent.js';
import type { Bid } from './marketplace.js';
import { BidStatus } from './marketplace.js';
import type { Task } from './task.js';
import { TaskStatus } from './task.js';

interface MeshEventBase<TType extends string> {
  type: TType;
  packageId: string;
  txDigest: string;
  timestampMs: number;
}

export interface AgentRegisteredEvent extends MeshEventBase<'agent.registered'> {
  registryId: string;
  agent: AgentCard;
}

export interface AgentUpdatedEvent extends MeshEventBase<'agent.updated'> {
  agent: AgentCard;
  previousVersion: number;
}

export interface AgentDeactivatedEvent extends MeshEventBase<'agent.deactivated'> {
  agentId: string;
  owner: string;
  deactivatedAt: number;
}

export interface TaskPostedEvent extends MeshEventBase<'task.posted'> {
  task: Task;
}

export interface TaskAcceptedEvent extends MeshEventBase<'task.accepted'> {
  taskId: string;
  requester: string;
  provider: string;
  acceptedAt: number;
  status: TaskStatus.ACCEPTED;
}

export interface TaskCompletedEvent extends MeshEventBase<'task.completed'> {
  taskId: string;
  provider: string;
  resultBlobId: string;
  completedAt: number;
  status: TaskStatus.COMPLETED;
}

export interface TaskReleasedEvent extends MeshEventBase<'task.released'> {
  taskId: string;
  requester: string;
  provider: string;
  releasedAt: number;
  status: TaskStatus.RELEASED;
}

export interface TaskDisputedEvent extends MeshEventBase<'task.disputed'> {
  taskId: string;
  requester: string;
  provider?: string;
  disputedAt: number;
  status: TaskStatus.DISPUTED;
}

export interface TaskCancelledEvent extends MeshEventBase<'task.cancelled'> {
  taskId: string;
  requester: string;
  cancelledAt: number;
  status: TaskStatus.CANCELLED;
}

export interface BidPlacedEvent extends MeshEventBase<'bid.placed'> {
  bid: Bid;
}

export interface BidAcceptedEvent extends MeshEventBase<'bid.accepted'> {
  bidId: string;
  taskId: string;
  requester: string;
  bidder: string;
  bidPrice: bigint;
  refundedAmount: bigint;
  acceptedAt: number;
  status: BidStatus.ACCEPTED;
}

export interface BidWithdrawnEvent extends MeshEventBase<'bid.withdrawn'> {
  bidId: string;
  taskId: string;
  bidder: string;
  withdrawnAt: number;
  status: BidStatus.WITHDRAWN;
}

export interface BidRejectedEvent extends MeshEventBase<'bid.rejected'> {
  bidId: string;
  taskId: string;
  requester: string;
  bidder: string;
  rejectedAt: number;
  status: BidStatus.REJECTED;
}

export type MeshEvent =
  | AgentRegisteredEvent
  | AgentUpdatedEvent
  | AgentDeactivatedEvent
  | TaskPostedEvent
  | TaskAcceptedEvent
  | TaskCompletedEvent
  | TaskReleasedEvent
  | TaskDisputedEvent
  | TaskCancelledEvent
  | BidPlacedEvent
  | BidAcceptedEvent
  | BidWithdrawnEvent
  | BidRejectedEvent;
