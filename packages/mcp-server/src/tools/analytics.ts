import type { MeshToolContext } from '../context.js';
import { executeIndexerQuery } from './indexer-client.js';

export interface MeshAnalyticsParams {
  view?: 'summary' | 'task-volume' | 'top-providers' | 'marketplace';
  period?: 'HOUR' | 'DAY' | 'WEEK';
  buckets?: number;
  limit?: number;
  sort_by?: 'COMPLETED_TASKS' | 'EARNINGS' | 'REPUTATION';
}

export const meshAnalyticsTool = {
  name: 'collective_analytics',
  description: 'Query task volume, top providers, and marketplace analytics from the Agentic Mesh indexer',
  inputSchema: {
    type: 'object' as const,
    properties: {
      view: { type: 'string', enum: ['summary', 'task-volume', 'top-providers', 'marketplace'] },
      period: { type: 'string', enum: ['HOUR', 'DAY', 'WEEK'] },
      buckets: { type: 'number' },
      limit: { type: 'number' },
      sort_by: { type: 'string', enum: ['COMPLETED_TASKS', 'EARNINGS', 'REPUTATION'] },
    },
  },
};

export async function runMeshAnalytics(
  params: MeshAnalyticsParams,
  context: MeshToolContext,
): Promise<Record<string, unknown>> {
  const view = params.view ?? 'summary';

  switch (view) {
    case 'task-volume': {
      const data = await executeIndexerQuery<{ taskVolume: unknown[] }>(
        context,
        `query TaskVolume($period: TimePeriod!, $buckets: Int) {
          taskVolume(period: $period, buckets: $buckets) {
            label
            count
            volumeMist
          }
        }`,
        {
          period: params.period ?? 'DAY',
          buckets: params.buckets ?? 14,
        },
      );
      return { view, period: params.period ?? 'DAY', buckets: params.buckets ?? 14, data: data.taskVolume };
    }
    case 'top-providers': {
      const data = await executeIndexerQuery<{ topProviders: unknown[] }>(
        context,
        `query TopProviders($limit: Int, $sortBy: ProviderSortField) {
          topProviders(limit: $limit, sortBy: $sortBy) {
            did
            owner
            name
            completedTasks
            earningsMist
            disputeCount
            successRate
            reputation
          }
        }`,
        {
          limit: params.limit ?? 10,
          sortBy: params.sort_by ?? 'COMPLETED_TASKS',
        },
      );
      return { view, limit: params.limit ?? 10, sort_by: params.sort_by ?? 'COMPLETED_TASKS', data: data.topProviders };
    }
    case 'marketplace': {
      const data = await executeIndexerQuery<{ analytics: { marketplace: unknown } }>(
        context,
        `query MarketplaceAnalytics {
          analytics {
            marketplace {
              averageBidCount
              acceptanceRate
              categoryPopularity {
                category
                taskCount
              }
            }
          }
        }`,
      );
      return { view, data: data.analytics.marketplace };
    }
    case 'summary':
    default: {
      const data = await executeIndexerQuery<{ analytics: unknown }>(
        context,
        `query AnalyticsSummary {
          analytics {
            totalAgents
            activeAgents
            totalTasks
            completedTasks
            disputedTasks
            totalVolumeMist
            averageGasCosts {
              capability
              averageGasMist
              taskCount
            }
            marketplace {
              averageBidCount
              acceptanceRate
              categoryPopularity {
                category
                taskCount
              }
            }
          }
        }`,
      );
      return { view: 'summary', data: data.analytics };
    }
  }
}
