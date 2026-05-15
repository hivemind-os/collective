import { TaskStatus } from '@agentic-mesh/types';

import type { MeshToolContext } from '../context.js';
import { fetchMeshBlob } from '../encryption.js';

const decoder = new TextDecoder();

export interface MeshTaskStatusParams {
  task_id: string;
}

export const meshTaskStatusTool = {
  name: 'mesh_task_status',
  description: 'Get task status and fetch the result if available',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task object id' },
    },
    required: ['task_id'],
  },
};

export async function runMeshTaskStatus(
  params: MeshTaskStatusParams,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  status: string;
  provider_did?: string;
  result?: string;
  price_mist: string;
  created_at: number;
}> {
  const task = await context.taskClient.getTask(params.task_id);
  if (!task) {
    throw new Error(`Task ${params.task_id} was not found.`);
  }

  let result: string | undefined;
  if ((task.status === TaskStatus.COMPLETED || task.status === TaskStatus.RELEASED) && task.resultBlobId) {
    const resultBytes = await fetchMeshBlob(context.blobStore, task.resultBlobId);
    result = resultBytes ? decoder.decode(resultBytes) : undefined;
  }

  return {
    task_id: task.id,
    status: TaskStatus[task.status] ?? 'UNKNOWN',
    provider_did: findProviderDid(context, task.provider),
    result,
    price_mist: task.price.toString(),
    created_at: task.createdAt,
  };
}

function findProviderDid(context: MeshToolContext, owner?: string): string | undefined {
  if (!owner) {
    return undefined;
  }

  return context.agentCache.getAllActive(1_000).find((agent) => agent.owner === owner)?.did;
}
