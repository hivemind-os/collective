import type { MeshToolContext } from '../context.js';

export const meshWorkQueueTool = {
  name: 'collective_work_queue',
  description:
    'Manage the provider work queue. Poll for incoming tasks (includes processing instructions if configured), complete or fail work items, and list queue contents.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['poll', 'complete', 'fail', 'list'],
        description:
          'poll: claim next pending work item. complete: submit result for a claimed item. fail: reject a claimed item. list: show queue contents.',
      },
      item_id: {
        type: 'string',
        description: 'The work item ID (required for complete and fail actions).',
      },
      result: {
        type: 'string',
        description: 'The result data to submit (required for complete action).',
      },
      error: {
        type: 'string',
        description: 'Error message (required for fail action).',
      },
      status_filter: {
        type: 'string',
        enum: ['pending', 'claimed', 'completed', 'failed'],
        description: 'Optional status filter for list action.',
      },
    },
    required: ['action'],
  },
};

interface WorkQueueParams {
  action: 'poll' | 'complete' | 'fail' | 'list';
  item_id?: string;
  result?: string;
  error?: string;
  status_filter?: string;
}

export async function runMeshWorkQueue(params: WorkQueueParams, context: MeshToolContext): Promise<unknown> {
  const queue = context.workQueue;
  if (!queue) {
    throw new Error(
      'Work queue is not available. Ensure the provider is configured with a job-queue adapter.',
    );
  }

  switch (params.action) {
    case 'poll': {
      const item = queue.poll();
      if (!item) {
        return { status: 'empty', message: 'No pending work items in the queue.' };
      }
      // Look up instructions from the capability's adapterConfig
      let instructions: string | undefined;
      if (context.providerConfig) {
        const snapshot = context.providerConfig.get();
        const cap = snapshot.capabilities.find(
          (c) => c.name === item.capability && c.adapter === 'job-queue',
        );
        instructions = cap?.adapterConfig?.instructions as string | undefined;
      }
      return {
        status: 'claimed',
        item: {
          id: item.id,
          taskId: item.taskId,
          capability: item.capability,
          inputData: item.inputData,
          createdAt: item.createdAt,
        },
        ...(instructions ? { instructions } : {}),
      };
    }

    case 'complete': {
      if (!params.item_id) {
        throw new Error('item_id is required for complete action.');
      }
      if (params.result === undefined) {
        throw new Error('result is required for complete action.');
      }
      const outcome = queue.complete(params.item_id, params.result);
      if (!outcome.ok) {
        throw new Error(outcome.error ?? 'Failed to complete work item.');
      }
      return { status: 'completed', itemId: params.item_id };
    }

    case 'fail': {
      if (!params.item_id) {
        throw new Error('item_id is required for fail action.');
      }
      if (!params.error) {
        throw new Error('error is required for fail action.');
      }
      const outcome = queue.fail(params.item_id, params.error);
      if (!outcome.ok) {
        throw new Error(outcome.error ?? 'Failed to fail work item.');
      }
      return { status: 'failed', itemId: params.item_id };
    }

    case 'list': {
      const filter = params.status_filter ? { status: params.status_filter } : undefined;
      const items = queue.list(filter);
      return {
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          taskId: item.taskId,
          capability: item.capability,
          status: item.status,
          createdAt: item.createdAt,
          claimedAt: item.claimedAt,
          completedAt: item.completedAt,
          inputPreview: item.inputData.slice(0, 200),
          error: item.error,
        })),
      };
    }

    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
