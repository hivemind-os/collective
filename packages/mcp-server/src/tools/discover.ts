import type { AgentCard, Capability } from '@agentic-mesh/types';
import { ReputationScoreCalculator } from '@agentic-mesh/core';

import type { MeshToolContext } from '../context.js';

const scoreCalculator = new ReputationScoreCalculator();

export interface MeshDiscoverParams {
  capability: string;
  limit?: number;
  sort_by?: 'price' | 'reputation';
}

export const meshDiscoverTool = {
  name: 'mesh_discover',
  description: 'Find agents by capability on the Agentic Mesh network',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability name to search for' },
      limit: { type: 'number', description: 'Max results (default 10)' },
      sort_by: { type: 'string', enum: ['price', 'reputation'], description: 'Sort results by price or reputation' },
    },
    required: ['capability'],
  },
};

export async function runMeshDiscover(
  params: MeshDiscoverParams,
  context: MeshToolContext,
): Promise<{ capability: string; agents: ReturnType<typeof summarizeAgent>[] }> {
  const capability = params.capability.trim();
  const limit = normalizeLimit(params.limit);
  const sortBy = params.sort_by ?? 'price';
  const agents = await discoverAgentsByCapability(capability, context, limit, sortBy);

  return {
    capability,
    agents: agents.map((agent) => summarizeAgent(agent, capability)),
  };
}

export async function discoverAgentsByCapability(
  capability: string,
  context: MeshToolContext,
  limit = 10,
  sortBy: 'price' | 'reputation' = 'price',
): Promise<AgentCard[]> {
  const normalizedCapability = capability.trim();
  if (!normalizedCapability) {
    return [];
  }

  const cached = context.agentCache
    .searchByCapability(normalizedCapability, Math.max(limit * 2, limit), { sortByReputation: sortBy === 'reputation' })
    .filter((agent) => hasCapability(agent, normalizedCapability))
    .slice(0, limit);

  if (cached.length > 0) {
    return sortBy === 'reputation' ? cached : sortByPrice(cached, normalizedCapability).slice(0, limit);
  }

  const discovered = await context.registryClient.discoverByCapability(normalizedCapability, limit, {
    sortByReputation: sortBy === 'reputation',
  });
  for (const agent of discovered) {
    context.agentCache.upsertAgent(agent);
  }

  const ranked = sortBy === 'reputation' ? discovered : sortByPrice(discovered, normalizedCapability);
  return ranked.slice(0, limit);
}

export async function resolveProviderCapability(
  capability: string,
  context: MeshToolContext,
  providerDid?: string,
): Promise<{ agent: AgentCard; capability: Capability }> {
  const normalizedCapability = capability.trim();
  if (!normalizedCapability) {
    throw new Error('Capability is required.');
  }

  if (providerDid) {
    const cachedAgent = context.agentCache.getAgentByDID(providerDid);
    const cachedCapability = cachedAgent ? findCapability(cachedAgent, normalizedCapability) : undefined;
    if (cachedAgent?.active && cachedCapability) {
      return { agent: cachedAgent, capability: cachedCapability };
    }

    const discovered = await discoverAgentsByCapability(normalizedCapability, context, 50);
    const matched = discovered.find((entry) => entry.did === providerDid);
    const matchedCapability = matched ? findCapability(matched, normalizedCapability) : undefined;
    if (!matched || !matchedCapability) {
      throw new Error(`Provider ${providerDid} was not found for capability ${normalizedCapability}.`);
    }

    return { agent: matched, capability: matchedCapability };
  }

  const discovered = await discoverAgentsByCapability(normalizedCapability, context, 20);
  const ranked = discovered
    .map((agent) => ({ agent, capability: findCapability(agent, normalizedCapability) }))
    .filter((entry): entry is { agent: AgentCard; capability: Capability } => Boolean(entry.capability))
    .sort((left, right) => compareBigInt(left.capability.pricing.amount, right.capability.pricing.amount));

  if (ranked.length === 0) {
    throw new Error(`No providers found for capability ${normalizedCapability}.`);
  }

  return ranked[0];
}

export function summarizeAgent(agent: AgentCard, capability?: string): {
  name: string;
  did: AgentCard['did'];
  capabilities: string[];
  pricing: Array<{
    capability: string;
    price_mist: string;
    rail: string;
    currency: string;
  }>;
  reputation: {
    success_rate: number;
    total_tasks: number;
    total_disputes: number;
    total_earnings_mist: string;
  };
  endpoint?: string;
} {
  const scopedCapabilities = capability
    ? agent.capabilities.filter((entry) => capabilityNameEquals(entry.name, capability))
    : agent.capabilities;
  const reputation = scoreCalculator.computeScore(agent, []);

  return {
    name: agent.name,
    did: agent.did,
    capabilities: scopedCapabilities.map((entry) => entry.name),
    pricing: scopedCapabilities.map((entry) => ({
      capability: entry.name,
      price_mist: entry.pricing.amount.toString(),
      rail: entry.pricing.rail,
      currency: entry.pricing.currency,
    })),
    reputation: {
      success_rate: reputation.successRate,
      total_tasks: reputation.totalTasks,
      total_disputes: reputation.totalDisputes,
      total_earnings_mist: reputation.totalEarningsMist.toString(),
    },
    endpoint: agent.endpoint,
  };
}

function findCapability(agent: AgentCard, capability: string): Capability | undefined {
  return agent.capabilities.find((entry) => capabilityNameEquals(entry.name, capability));
}

function hasCapability(agent: AgentCard, capability: string): boolean {
  return findCapability(agent, capability) !== undefined;
}

function capabilityNameEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 10;
  }

  return Math.max(1, Math.floor(limit));
}

function sortByPrice(agents: AgentCard[], capability: string): AgentCard[] {
  return [...agents].sort((left, right) => {
    const leftCapability = findCapability(left, capability);
    const rightCapability = findCapability(right, capability);
    if (!leftCapability && !rightCapability) {
      return 0;
    }
    if (!leftCapability) {
      return 1;
    }
    if (!rightCapability) {
      return -1;
    }
    return compareBigInt(leftCapability.pricing.amount, rightCapability.pricing.amount);
  });
}