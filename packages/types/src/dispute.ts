export enum DisputeStatus {
  OPEN = 0,
  RESPONDED = 1,
  MUTUAL_RESOLVED = 2,
  ARBITRATED = 3,
  EXPIRED = 4,
}

export interface Dispute {
  id: string;
  taskId: string;
  requester: string;
  provider: string;
  escrowAmount: bigint;
  status: DisputeStatus;
  requesterEvidenceBlob: string;
  providerEvidenceBlob?: string;
  requesterProposedSplit: bigint;
  providerProposedSplit: bigint;
  arbitrator?: string;
  rulingSplit: bigint;
  openedAt: number;
  respondedAt?: number;
  resolvedAt?: number;
  resolutionDeadline: number;
}
