import { TaskStatus } from '@agentic-mesh/types';

import type { MeshToolContext } from '../context.js';

const decoder = new TextDecoder();

export const meshTaskResourceTemplate = {
  uriTemplate: 'mesh://task/{id}',
  name: 'Task Details',
  description: 'Resolve task details and result payload by task id',
  mimeType: 'application/json',
};

export async function readTaskResource(taskId: string, context: MeshToolContext): Promise<{
  id: string;
  requester: string;
  provider?: string;
  capability: string;
  input_blob_id: string;
  result_blob_id?: string;
  price_mist: string;
  status: string;
  created_at: number;
  accepted_at?: number;
  completed_at?: number;
  expires_at: number;
  agreement_hash?: string;
  result?: string;
}> {
  const task = await context.taskClient.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  let result: string | undefined;
  if ((task.status === TaskStatus.COMPLETED || task.status === TaskStatus.RELEASED) && task.resultBlobId) {
    const bytes = await context.blobStore.fetch(task.resultBlobId);
    result = bytes ? decoder.decode(bytes) : undefined;
  }

  return {
    id: task.id,
    requester: task.requester,
    provider: task.provider,
    capability: task.capability,
    input_blob_id: task.inputBlobId,
    result_blob_id: task.resultBlobId,
    price_mist: task.price.toString(),
    status: TaskStatus[task.status] ?? 'UNKNOWN',
    created_at: task.createdAt,
    accepted_at: task.acceptedAt,
    completed_at: task.completedAt,
    expires_at: task.expiresAt,
    agreement_hash: task.agreementHash,
    result,
  };
}
