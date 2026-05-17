import type { PaymentRail, PricingInfo } from './payment.js';

declare const didBrand: unique symbol;

export type DID = `did:mesh:${string}` & {
  readonly [didBrand]: 'DID';
};

export interface RelayEndpoint {
  relayDid?: DID;
  endpoint: string;
  modes?: Array<'sync' | 'streaming' | 'fallback' | 'negotiation'>;
}

export interface Capability {
  name: string;
  description: string;
  version: string;
  pricing: PricingInfo;
  executionMode?: 'sync' | 'async';
  paymentRails?: PaymentRail[];
}

export enum AgentStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export interface AgentCard {
  id: string;
  owner: string;
  did: DID;
  name: string;
  description: string;
  capabilities: Capability[];
  endpoint?: string;
  relayEndpoints?: RelayEndpoint[];
  encryptionPublicKey?: string;
  payoutAddress?: string;
  active: boolean;
  version: number;
  registeredAt: number;
  updatedAt: number;
  totalTasksCompleted?: number;
  totalTasksFailed?: number;
  totalTasksDisputed?: number;
  totalEarningsMist?: bigint;
  hasStake?: boolean;
  stakeMist?: bigint;
  stakeType?: 'agent' | 'relay';
}
