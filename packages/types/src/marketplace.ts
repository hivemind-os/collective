export enum BidStatus {
  ACTIVE = 0,
  ACCEPTED = 1,
  REJECTED = 2,
  WITHDRAWN = 3,
}

export type TaskCategory = string;

export const TaskCategories = {
  GENERAL: 'general',
  ANALYSIS: 'analysis',
  CODE: 'code',
  DATA: 'data',
  RESEARCH: 'research',
} as const;

export interface Bid {
  id: string;
  taskId: string;
  bidder: string;
  bidPrice: bigint;
  reputationScore: bigint;
  evidenceBlob?: string;
  createdAt: number;
  status: BidStatus;
}

export interface BidRecommendation {
  bid: Bid;
  score: bigint;
  reputationWeight: bigint;
  priceWeight: bigint;
}
