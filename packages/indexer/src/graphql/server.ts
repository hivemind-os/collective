import { createServer, type Server as HttpServer } from 'node:http';

import { createSchema, createYoga } from 'graphql-yoga';
import { BidStatus, DisputeStatus, PaymentScheme, TaskStatus, type AgentCard, type Capability } from '@hivemind-os/collective-types';

import { AnalyticsEngine, type ProviderSortField, type TimePeriod } from '../analytics.js';
import { type AgentQueryFilters, encodeCursor, type IndexedTask, type IndexerStore } from '../store.js';

export interface IndexerGraphQLServerOptions {
  store: IndexerStore;
  analytics?: AnalyticsEngine;
  host?: string;
  port?: number;
  logger?: {
    info?: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
}

export interface IndexerGraphQLServer {
  schema: ReturnType<typeof createSchema>;
  server: HttpServer;
  fetch: typeof fetch;
  start: () => Promise<string>;
  stop: () => Promise<void>;
}

const MAX_PAGE_SIZE = 100;

export function createIndexerGraphQLServer(options: IndexerGraphQLServerOptions): IndexerGraphQLServer {
  const analytics = options.analytics ?? new AnalyticsEngine(options.store);
  const schema = createSchema({
    typeDefs: /* GraphQL */ `
      enum TaskStatus {
        OPEN
        ACCEPTED
        COMPLETED
        RELEASED
        DISPUTED
        CANCELLED
      }

      enum PaymentScheme {
        EXACT
        UPTO
        STREAM
      }

      enum BidStatus {
        ACTIVE
        ACCEPTED
        REJECTED
        WITHDRAWN
      }

      enum DisputeStatus {
        OPEN
        RESPONDED
        MUTUAL_RESOLVED
        ARBITRATED
        EXPIRED
      }

      enum TimePeriod {
        HOUR
        DAY
        WEEK
      }

      enum ProviderSortField {
        COMPLETED_TASKS
        EARNINGS
        REPUTATION
      }

      type PageInfo {
        hasNextPage: Boolean!
        endCursor: String
      }

      type AgentConnection {
        nodes: [Agent!]!
        totalCount: Int!
        pageInfo: PageInfo!
      }

      type TaskConnection {
        nodes: [Task!]!
        pageInfo: PageInfo!
      }

      type PricingInfo {
        rail: String!
        amount: String!
        currency: String!
      }

      type Capability {
        name: String!
        description: String!
        version: String!
        pricing: PricingInfo!
        executionMode: String
        paymentRails: [String!]!
      }

      type AgentReputation {
        successRate: Float!
        totalTasks: Int!
        totalDisputes: Int!
        totalEarningsMist: String!
        stakeAmountMist: String!
      }

      type Agent {
        id: ID!
        owner: String!
        did: String!
        name: String!
        description: String!
        endpoint: String
        active: Boolean!
        version: Int!
        registeredAt: String!
        updatedAt: String!
        capabilities: [Capability!]!
        totalTasksCompleted: Int!
        totalTasksFailed: Int!
        totalTasksDisputed: Int!
        totalEarningsMist: String!
        hasStake: Boolean!
        stakeMist: String
        stakeType: String
        categories: [String!]!
        reputation: AgentReputation!
      }

      type TaskTransition {
        eventType: String!
        status: TaskStatus!
        txDigest: String!
        timestampMs: String!
      }

      type Task {
        id: ID!
        requester: String!
        provider: String
        capability: String!
        category: String!
        inputBlobId: String!
        resultBlobId: String
        price: String!
        paymentScheme: PaymentScheme
        maxPrice: String
        meteredUnits: Int
        unitPrice: String
        verificationHash: String
        status: TaskStatus!
        disputeWindowMs: Int!
        createdAt: String!
        acceptedAt: String
        completedAt: String
        releasedAt: String
        disputedAt: String
        cancelledAt: String
        expiresAt: String!
        agreementHash: String
        bidCount: Int!
        gasCostMistTotal: String!
        transitions: [TaskTransition!]!
      }

      type Bid {
        id: ID!
        taskId: String!
        bidder: String!
        bidPrice: String!
        reputationScore: String!
        evidenceBlob: String
        createdAt: String!
        status: BidStatus!
      }

      type Dispute {
        id: ID!
        taskId: String!
        requester: String!
        provider: String!
        escrowAmount: String!
        status: DisputeStatus!
        requesterEvidenceBlob: String!
        providerEvidenceBlob: String
        requesterProposedSplit: String!
        providerProposedSplit: String!
        arbitrator: String
        rulingSplit: String!
        openedAt: String!
        respondedAt: String
        resolvedAt: String
        resolutionDeadline: String!
      }

      type GasCostStat {
        capability: String!
        averageGasMist: String!
        taskCount: Int!
      }

      type CategoryStat {
        category: String!
        taskCount: Int!
      }

      type MarketplaceStats {
        averageBidCount: Float!
        acceptanceRate: Float!
        categoryPopularity: [CategoryStat!]!
      }

      type Analytics {
        totalAgents: Int!
        activeAgents: Int!
        totalTasks: Int!
        completedTasks: Int!
        disputedTasks: Int!
        totalVolumeMist: String!
        averageGasCosts: [GasCostStat!]!
        marketplace: MarketplaceStats!
      }

      type TimeBucket {
        label: String!
        count: Int!
        volumeMist: String!
      }

      type ProviderStats {
        did: String!
        owner: String!
        name: String!
        completedTasks: Int!
        earningsMist: String!
        disputeCount: Int!
        successRate: Float!
        reputation: Float!
      }

      type Query {
        agents(capability: String, minReputation: Float, category: String, limit: Int, offset: Int): AgentConnection!
        agent(did: String!): Agent
        tasks(status: TaskStatus, requester: String, provider: String, category: String, after: String, limit: Int): TaskConnection!
        task(id: String!): Task
        bids(taskId: String!, status: BidStatus): [Bid!]!
        disputes(status: DisputeStatus, agent: String): [Dispute!]!
        analytics: Analytics!
        taskVolume(period: TimePeriod!, buckets: Int): [TimeBucket!]!
        topProviders(limit: Int, sortBy: ProviderSortField): [ProviderStats!]!
      }
    `,
    resolvers: {
      TaskStatus: {
        OPEN: TaskStatus.OPEN,
        ACCEPTED: TaskStatus.ACCEPTED,
        COMPLETED: TaskStatus.COMPLETED,
        RELEASED: TaskStatus.RELEASED,
        DISPUTED: TaskStatus.DISPUTED,
        CANCELLED: TaskStatus.CANCELLED,
      },
      BidStatus: {
        ACTIVE: BidStatus.ACTIVE,
        ACCEPTED: BidStatus.ACCEPTED,
        REJECTED: BidStatus.REJECTED,
        WITHDRAWN: BidStatus.WITHDRAWN,
      },
      PaymentScheme: {
        EXACT: PaymentScheme.EXACT,
        UPTO: PaymentScheme.UPTO,
        STREAM: PaymentScheme.STREAM,
      },
      DisputeStatus: {
        OPEN: DisputeStatus.OPEN,
        RESPONDED: DisputeStatus.RESPONDED,
        MUTUAL_RESOLVED: DisputeStatus.MUTUAL_RESOLVED,
        ARBITRATED: DisputeStatus.ARBITRATED,
        EXPIRED: DisputeStatus.EXPIRED,
      },
      TimePeriod: {
        HOUR: 'hour' satisfies TimePeriod,
        DAY: 'day' satisfies TimePeriod,
        WEEK: 'week' satisfies TimePeriod,
      },
      ProviderSortField: {
        COMPLETED_TASKS: 'completedTasks' satisfies ProviderSortField,
        EARNINGS: 'earnings' satisfies ProviderSortField,
        REPUTATION: 'reputation' satisfies ProviderSortField,
      },
      Query: {
        agents: (_root: unknown, args: AgentQueryFilters) => {
          const limit = normalizeLimit(args.limit, 20);
          const offset = normalizeOffset(args.offset);
          const capability = trimOptional(args.capability);
          const category = trimOptional(args.category);
          const nodes = options.store.queryAgents({
            capability,
            minReputation: normalizeOptionalFloat(args.minReputation, 'minReputation'),
            category,
            limit,
            offset,
            sortBy: 'reputation',
          });
          const totalCount = options.store.countAgents({
            capability,
            minReputation: normalizeOptionalFloat(args.minReputation, 'minReputation'),
            category,
            sortBy: 'reputation',
          });
          return {
            nodes,
            totalCount,
            pageInfo: {
              hasNextPage: offset + nodes.length < totalCount,
              endCursor: nodes.length > 0 ? Buffer.from(String(offset + nodes.length)).toString('base64url') : null,
            },
          };
        },
        agent: (_root: unknown, args: { did: string }) => options.store.getAgentByDid(requireNonEmpty(args.did, 'did')),
        tasks: (_root: unknown, args: { status?: TaskStatus; requester?: string; provider?: string; category?: string; after?: string; limit?: number }) => {
          const limit = normalizeLimit(args.limit, 20);
          const rows = options.store.queryTasks({
            status: args.status,
            requester: trimOptional(args.requester),
            provider: trimOptional(args.provider),
            category: trimOptional(args.category),
            after: trimOptional(args.after),
            limit: limit + 1,
          });
          const nodes = rows.slice(0, limit);
          const endCursor = nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1] as IndexedTask) : null;
          return {
            nodes,
            pageInfo: {
              hasNextPage: rows.length > limit,
              endCursor,
            },
          };
        },
        task: (_root: unknown, args: { id: string }) => options.store.getTask(requireNonEmpty(args.id, 'id')),
        bids: (_root: unknown, args: { taskId: string; status?: BidStatus }) => options.store.getBids(requireNonEmpty(args.taskId, 'taskId'), args.status),
        disputes: (_root: unknown, args: { status?: DisputeStatus; agent?: string }) =>
          options.store.getDisputes({ status: args.status, agent: trimOptional(args.agent) }),
        analytics: () => analytics.getSummary(),
        taskVolume: (_root: unknown, args: { period: TimePeriod; buckets?: number }) => analytics.getTaskVolume(args.period, args.buckets),
        topProviders: (_root: unknown, args: { limit?: number; sortBy?: ProviderSortField }) =>
          analytics.getTopProviders(normalizeLimit(args.limit, 10), args.sortBy),
      },
      Agent: {
        registeredAt: (agent: AgentCard) => String(agent.registeredAt),
        updatedAt: (agent: AgentCard) => String(agent.updatedAt),
        totalTasksCompleted: (agent: AgentCard) => agent.totalTasksCompleted ?? 0,
        totalTasksFailed: (agent: AgentCard) => agent.totalTasksFailed ?? 0,
        totalTasksDisputed: (agent: AgentCard) => agent.totalTasksDisputed ?? 0,
        totalEarningsMist: (agent: AgentCard) => (agent.totalEarningsMist ?? 0n).toString(),
        hasStake: (agent: AgentCard) => Boolean(agent.hasStake),
        stakeMist: (agent: AgentCard) => agent.stakeMist?.toString() ?? null,
        categories: (agent: AgentCard) => listAgentCategories(options.store, agent.owner),
        reputation: (agent: AgentCard) => buildAgentReputation(agent),
      },
      Capability: {
        paymentRails: (capability: Capability) => capability.paymentRails ?? [],
      },
      PricingInfo: {
        amount: (pricing: Capability['pricing']) => pricing.amount.toString(),
      },
      Task: {
        price: (task: IndexedTask) => task.price.toString(),
        maxPrice: (task: IndexedTask) => task.maxPrice?.toString() ?? null,
        meteredUnits: (task: IndexedTask) => task.meteredUnits ?? null,
        unitPrice: (task: IndexedTask) => task.unitPrice?.toString() ?? null,
        verificationHash: (task: IndexedTask) => task.verificationHash ?? null,
        createdAt: (task: IndexedTask) => String(task.createdAt),
        acceptedAt: (task: IndexedTask) => nullableString(task.acceptedAt),
        completedAt: (task: IndexedTask) => nullableString(task.completedAt),
        releasedAt: (task: IndexedTask) => nullableString(task.releasedAt),
        disputedAt: (task: IndexedTask) => nullableString(task.disputedAt),
        cancelledAt: (task: IndexedTask) => nullableString(task.cancelledAt),
        expiresAt: (task: IndexedTask) => String(task.expiresAt),
        gasCostMistTotal: (task: IndexedTask) => task.gasCostMistTotal.toString(),
        transitions: (task: IndexedTask) => task.transitions ?? options.store.getTaskTransitions(task.id),
      },
      TaskTransition: {
        timestampMs: (transition: { timestampMs: number }) => String(transition.timestampMs),
      },
      Bid: {
        taskId: (bid: { taskId: string }) => bid.taskId,
        bidPrice: (bid: { bidPrice: bigint }) => bid.bidPrice.toString(),
        reputationScore: (bid: { reputationScore: bigint }) => bid.reputationScore.toString(),
        createdAt: (bid: { createdAt: number }) => String(bid.createdAt),
      },
      Dispute: {
        taskId: (dispute: { taskId: string }) => dispute.taskId,
        escrowAmount: (dispute: { escrowAmount: bigint }) => dispute.escrowAmount.toString(),
        requesterProposedSplit: (dispute: { requesterProposedSplit: bigint }) => dispute.requesterProposedSplit.toString(),
        providerProposedSplit: (dispute: { providerProposedSplit: bigint }) => dispute.providerProposedSplit.toString(),
        rulingSplit: (dispute: { rulingSplit: bigint }) => dispute.rulingSplit.toString(),
        openedAt: (dispute: { openedAt: number }) => String(dispute.openedAt),
        respondedAt: (dispute: { respondedAt?: number }) => nullableString(dispute.respondedAt),
        resolvedAt: (dispute: { resolvedAt?: number }) => nullableString(dispute.resolvedAt),
        resolutionDeadline: (dispute: { resolutionDeadline: number }) => String(dispute.resolutionDeadline),
      },
      GasCostStat: {
        averageGasMist: (row: { averageGasMist: bigint }) => row.averageGasMist.toString(),
      },
      Analytics: {
        totalVolumeMist: (summary: { totalVolumeMist: bigint }) => summary.totalVolumeMist.toString(),
      },
      TimeBucket: {
        volumeMist: (bucket: { volumeMist: bigint }) => bucket.volumeMist.toString(),
      },
      ProviderStats: {
        earningsMist: (row: { earningsMist: bigint }) => row.earningsMist.toString(),
      },
    },
  });

  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    maskedErrors: true,
  });
  const server = createServer(yoga);

  return {
    schema,
    server,
    fetch: yoga.fetch.bind(yoga) as typeof fetch,
    start: async () => await startServer(server, options.host ?? '0.0.0.0', options.port ?? 4000, options.logger),
    stop: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
  };
}

function listAgentCategories(store: IndexerStore, owner: string): string[] {
  const rows = store
    .getDatabase()
    .prepare('SELECT DISTINCT category FROM tasks WHERE provider = ? ORDER BY category ASC')
    .all(owner) as Array<{ category: string }>;
  return rows.map((row) => row.category);
}

function buildAgentReputation(agent: AgentCard): {
  successRate: number;
  totalTasks: number;
  totalDisputes: number;
  totalEarningsMist: string;
  stakeAmountMist: string;
} {
  const completed = agent.totalTasksCompleted ?? 0;
  const failed = agent.totalTasksFailed ?? 0;
  const totalTasks = completed + failed;
  return {
    successRate: totalTasks === 0 ? 0 : completed / totalTasks,
    totalTasks,
    totalDisputes: agent.totalTasksDisputed ?? 0,
    totalEarningsMist: (agent.totalEarningsMist ?? 0n).toString(),
    stakeAmountMist: (agent.stakeMist ?? 0n).toString(),
  };
}

function nullableString(value?: number | null): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

async function startServer(
  server: HttpServer,
  host: string,
  port: number,
  logger?: IndexerGraphQLServerOptions['logger'],
): Promise<string> {
  const address = await new Promise<string>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const boundAddress = server.address();
      const resolvedPort = typeof boundAddress === 'object' && boundAddress ? boundAddress.port : port;
      resolvePromise(`http://${host}:${resolvedPort}/graphql`);
    });
  });
  logger?.info?.({ address }, 'Indexer GraphQL server started');
  return address;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)))
    : Math.min(MAX_PAGE_SIZE, fallback);
}

function normalizeOffset(offset: number | undefined): number {
  return typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
}

function normalizeOptionalFloat(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number.`);
  }
  return value;
}

function trimOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}
