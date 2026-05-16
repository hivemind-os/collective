import type { AgentCard, Capability } from '@hivemind-os/collective-types';

import type { MeshToolContext } from '../context.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface GraphQLAgentNode {
  id: string;
  owner: string;
  did: string;
  name: string;
  description: string;
  endpoint?: string | null;
  active: boolean;
  version: number;
  registeredAt: string;
  updatedAt: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  totalTasksDisputed: number;
  totalEarningsMist: string;
  hasStake: boolean;
  stakeMist?: string | null;
  stakeType?: 'agent' | 'relay' | null;
  capabilities: Array<{
    name: string;
    description: string;
    version: string;
    executionMode?: 'sync' | 'async' | null;
    paymentRails?: string[] | null;
    pricing: {
      rail: Capability['pricing']['rail'];
      amount: string;
      currency: string;
    };
  }>;
}

export async function executeIndexerQuery<TData>(
  context: Pick<MeshToolContext, 'indexer'>,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const endpoint = resolveIndexerUrl(context);
  if (!endpoint) {
    throw new Error('Indexer is not configured.');
  }

  const fetchImpl = context.indexer?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Indexer query failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as GraphQLResponse<TData>;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors.map((entry) => entry.message ?? 'Unknown GraphQL error').join('; '));
  }
  if (!payload.data) {
    throw new Error('Indexer query returned no data.');
  }
  return payload.data;
}

export async function queryIndexerAgents(
  context: Pick<MeshToolContext, 'indexer'>,
  params: { capability: string; limit: number; minReputation?: number; category?: string },
): Promise<AgentCard[]> {
  const data = await executeIndexerQuery<{ agents: { nodes: GraphQLAgentNode[] } }>(
    context,
    `query IndexedAgents($capability: String, $limit: Int, $minReputation: Float, $category: String) {
      agents(capability: $capability, limit: $limit, minReputation: $minReputation, category: $category) {
        nodes {
          id
          owner
          did
          name
          description
          endpoint
          active
          version
          registeredAt
          updatedAt
          totalTasksCompleted
          totalTasksFailed
          totalTasksDisputed
          totalEarningsMist
          hasStake
          stakeMist
          stakeType
          capabilities {
            name
            description
            version
            executionMode
            paymentRails
            pricing {
              rail
              amount
              currency
            }
          }
        }
      }
    }`,
    {
      capability: params.capability,
      limit: params.limit,
      minReputation: params.minReputation,
      category: params.category,
    },
  );

  return data.agents.nodes.map(mapGraphqlAgent);
}

export function resolveIndexerUrl(context: Pick<MeshToolContext, 'indexer'>): string | null {
  const value = context.indexer?.graphqlUrl ?? process.env.COLLECTIVE_INDEXER_URL;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function mapGraphqlAgent(agent: GraphQLAgentNode): AgentCard {
  return {
    id: agent.id,
    owner: agent.owner,
    did: agent.did as AgentCard['did'],
    name: agent.name,
    description: agent.description,
    endpoint: agent.endpoint ?? undefined,
    active: agent.active,
    version: agent.version,
    registeredAt: Number(agent.registeredAt),
    updatedAt: Number(agent.updatedAt),
    totalTasksCompleted: agent.totalTasksCompleted,
    totalTasksFailed: agent.totalTasksFailed,
    totalTasksDisputed: agent.totalTasksDisputed,
    totalEarningsMist: BigInt(agent.totalEarningsMist),
    hasStake: agent.hasStake,
    stakeMist: agent.stakeMist ? BigInt(agent.stakeMist) : undefined,
    stakeType: agent.stakeType ?? undefined,
    capabilities: agent.capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      version: capability.version,
      executionMode: capability.executionMode ?? undefined,
      paymentRails: capability.paymentRails ?? undefined,
      pricing: {
        rail: capability.pricing.rail,
        amount: BigInt(capability.pricing.amount),
        currency: capability.pricing.currency,
      },
    })),
  };
}
