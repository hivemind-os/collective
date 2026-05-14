import type { PricingInfo } from './payment.js';

declare const didBrand: unique symbol;

export type DID = `did:mesh:${string}` & {
  readonly [didBrand]: 'DID';
};

export interface Capability {
  name: string;
  description: string;
  version: string;
  pricing: PricingInfo;
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
  active: boolean;
  version: number;
  registeredAt: number;
  updatedAt: number;
}
