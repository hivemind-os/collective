export enum RelayNodeStatus {
  ACTIVE = 0,
  INACTIVE = 1,
  SLASHED = 2,
}

export interface RelayNode {
  id: string;
  operator: string;
  endpoint: string;
  stakePositionId: string;
  capabilities: string[];
  region: string;
  status: RelayNodeStatus;
  registeredAt: number;
  lastHeartbeat: number;
  routingFeeBps: number;
  totalRouted: number;
  totalFeesEarnedMist: bigint;
  stakeAmountMist?: bigint;
  heartbeatAgeMs?: number;
  isHeartbeatFresh?: boolean;
}

export interface RelayListFilters {
  status?: RelayNodeStatus | RelayNodeStatus[];
  activeOnly?: boolean;
  capability?: string;
  region?: string;
  operator?: string;
  stakePositionId?: string;
  endpoint?: string;
  heartbeatWithinMs?: number;
}
