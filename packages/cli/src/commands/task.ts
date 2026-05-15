import { MeshSuiClient, TaskClient } from '@agentic-mesh/core';
import { TaskStatus } from '@agentic-mesh/types';

import { loadMeshConfig } from './config.js';
import { formatMistToSui } from './wallet.js';
import { success, table } from '../utils/output.js';

export async function handleTask(subcommand?: string, args: string[] = []): Promise<number> {
  if (subcommand !== 'status') {
    throw new Error('Usage: mesh task status <id>');
  }

  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: mesh task status <id>');
  }

  const config = loadMeshConfig();
  const taskClient = new TaskClient(new MeshSuiClient(config.network), config.network);
  const task = await taskClient.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  success(`Task ${task.id}`);
  table(
    ['Field', 'Value'],
    [
      ['Status', TaskStatus[task.status] ?? 'UNKNOWN'],
      ['Capability', task.capability],
      ['Category', task.category],
      ['Price (SUI)', formatMistToSui(task.price)],
      ['Requester', task.requester],
      ['Provider', task.provider ?? '-'],
      ['Result Blob', task.resultBlobId ?? '-'],
      ['Created', new Date(task.createdAt).toISOString()],
      ['Expires', new Date(task.expiresAt).toISOString()],
    ],
  );
  return 0;
}
