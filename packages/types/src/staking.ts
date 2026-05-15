export interface StakePosition {
  id: string;
  owner: string;
  stakeType: 'agent' | 'relay';
  balanceMist: bigint;
  stakedAt: number;
  deactivatedAt: number;
  slashedAmount: bigint;
  isActive?: boolean;
  meetsMinium?: boolean;
  meetsMinimum?: boolean;
}

export interface SlashRecord {
  id: string;
  target: string;
  evidenceType: 'expired_escrow' | 'non_delivery';
  taskId: string;
  amount: bigint;
  timestamp: number;
}
