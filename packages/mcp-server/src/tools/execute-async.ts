import type { MeshToolContext } from '../context.js';
import { prepareMeshExecution, type MeshExecuteParams } from './execute.js';

export interface MeshExecuteAsyncParams
  extends Pick<MeshExecuteParams, 'capability' | 'provider_did' | 'input' | 'max_price_mist'> {}

export const meshExecuteAsyncTool = {
  name: 'collective_execute_async',
  description: 'Submit a mesh task and return immediately',
  inputSchema: {
    type: 'object' as const,
    properties: {
      capability: { type: 'string', description: 'Capability name to execute' },
      provider_did: { type: 'string', description: 'Specific provider DID to use' },
      input: { type: 'string', description: 'Task input payload' },
      max_price_mist: { type: 'number', description: 'Maximum spend in MIST' },
    },
    required: ['capability', 'input'],
  },
};

export async function runMeshExecuteAsync(
  params: MeshExecuteAsyncParams,
  context: MeshToolContext,
): Promise<{
  task_id: string;
  provider_did: string;
  price_mist: string;
  status: 'OPEN';
}> {
  const prepared = await prepareMeshExecution(params, context);

  return {
    task_id: prepared.taskId,
    provider_did: prepared.providerDid,
    price_mist: prepared.priceMist.toString(),
    status: 'OPEN',
  };
}
