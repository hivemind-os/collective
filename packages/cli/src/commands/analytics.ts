import type { MeshCliConfig } from './config.js';
import { loadMeshConfig } from './config.js';
import { info, table } from '../utils/output.js';

export interface AnalyticsCommandDeps {
  loadConfig?: () => MeshCliConfig;
  fetchImpl?: typeof fetch;
}

export async function handleAnalytics(
  subcommand?: string,
  args: string[] = [],
  deps: AnalyticsCommandDeps = {},
): Promise<number> {
  switch (subcommand) {
    case 'summary':
      return await showAnalyticsSummary(deps);
    case 'top-providers':
      return await showTopProviders(args, deps);
    case 'task-volume':
      return await showTaskVolume(args, deps);
    default:
      throw new Error('Usage: mesh analytics <summary|top-providers|task-volume>');
  }
}

async function showAnalyticsSummary(deps: AnalyticsCommandDeps): Promise<number> {
  const data = await queryIndexer<{ analytics: {
    totalAgents: number;
    activeAgents: number;
    totalTasks: number;
    completedTasks: number;
    disputedTasks: number;
    totalVolumeMist: string;
    marketplace: { averageBidCount: number; acceptanceRate: number };
  } }>(deps, `query AnalyticsSummary {
    analytics {
      totalAgents
      activeAgents
      totalTasks
      completedTasks
      disputedTasks
      totalVolumeMist
      marketplace {
        averageBidCount
        acceptanceRate
      }
    }
  }`);

  info('Agentic Mesh analytics summary');
  table(
    ['Metric', 'Value'],
    [
      ['Total Agents', String(data.analytics.totalAgents)],
      ['Active Agents', String(data.analytics.activeAgents)],
      ['Total Tasks', String(data.analytics.totalTasks)],
      ['Completed Tasks', String(data.analytics.completedTasks)],
      ['Disputed Tasks', String(data.analytics.disputedTasks)],
      ['Total Volume (MIST)', data.analytics.totalVolumeMist],
      ['Average Bid Count', data.analytics.marketplace.averageBidCount.toFixed(2)],
      ['Acceptance Rate', `${(data.analytics.marketplace.acceptanceRate * 100).toFixed(1)}%`],
    ],
  );
  return 0;
}

async function showTopProviders(args: string[], deps: AnalyticsCommandDeps): Promise<number> {
  const limit = readNumericFlag(args, '--limit') ?? 10;
  const sortBy = (readStringFlag(args, '--sort-by') ?? 'COMPLETED_TASKS').toUpperCase();
  const data = await queryIndexer<{ topProviders: Array<{
    name: string;
    did: string;
    completedTasks: number;
    earningsMist: string;
    successRate: number;
    reputation: number;
  }> }>(deps, `query TopProviders($limit: Int, $sortBy: ProviderSortField) {
    topProviders(limit: $limit, sortBy: $sortBy) {
      name
      did
      completedTasks
      earningsMist
      successRate
      reputation
    }
  }`, { limit, sortBy });

  info(`Top ${data.topProviders.length} providers`);
  table(
    ['Name', 'DID', 'Completed', 'Earnings (MIST)', 'Success Rate', 'Reputation'],
    data.topProviders.map((provider) => [
      provider.name,
      provider.did,
      String(provider.completedTasks),
      provider.earningsMist,
      `${(provider.successRate * 100).toFixed(1)}%`,
      provider.reputation.toFixed(2),
    ]),
  );
  return 0;
}

async function showTaskVolume(args: string[], deps: AnalyticsCommandDeps): Promise<number> {
  const period = (readStringFlag(args, '--period') ?? 'DAY').toUpperCase();
  const buckets = readNumericFlag(args, '--buckets') ?? 14;
  const data = await queryIndexer<{ taskVolume: Array<{ label: string; count: number; volumeMist: string }> }>(
    deps,
    `query TaskVolume($period: TimePeriod!, $buckets: Int) {
      taskVolume(period: $period, buckets: $buckets) {
        label
        count
        volumeMist
      }
    }`,
    { period, buckets },
  );

  info(`Task volume by ${period.toLowerCase()}`);
  table(
    ['Bucket', 'Tasks', 'Volume (MIST)'],
    data.taskVolume.map((bucket) => [bucket.label, String(bucket.count), bucket.volumeMist]),
  );
  return 0;
}

async function queryIndexer<TData>(
  deps: AnalyticsCommandDeps,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const config = (deps.loadConfig ?? loadMeshConfig)();
  if (!config.indexer.url) {
    throw new Error('indexer.url must be configured before using analytics commands.');
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(config.indexer.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Indexer query failed with status ${response.status}.`);
  }
  const payload = (await response.json()) as { data?: TData; errors?: Array<{ message?: string }> };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((entry) => entry.message ?? 'Unknown GraphQL error').join('; '));
  }
  if (!payload.data) {
    throw new Error('Indexer query returned no data.');
  }
  return payload.data;
}

function readStringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  if (!value) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function readNumericFlag(args: string[], name: string): number | undefined {
  const value = readStringFlag(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return Math.floor(parsed);
}
