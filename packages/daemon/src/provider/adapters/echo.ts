import { createHash } from 'node:crypto';

import type { ExecutionAdapter } from './interface.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export class EchoAdapter implements ExecutionAdapter {
  readonly name = 'echo';

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    const result = {
      echo: decodeInput(params.inputData),
      taskId: params.taskId,
      capability: params.capability,
      timestamp: Date.now(),
      inputHash: createHash('sha256').update(params.inputData).digest('hex'),
    };

    return {
      resultData: encoder.encode(JSON.stringify(result)),
    };
  }
}

function decodeInput(input: Uint8Array): string {
  try {
    return decoder.decode(input);
  } catch {
    return Buffer.from(input).toString('hex');
  }
}
