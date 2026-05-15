import type { ExecutionAdapter } from './interface.js';

export type LocalFunction = (input: Uint8Array, metadata?: Record<string, string>) => Promise<Uint8Array>;

export class LocalFunctionAdapter implements ExecutionAdapter {
  readonly name = 'local-function';

  constructor(private readonly fn: LocalFunction) {}

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    return {
      resultData: await this.fn(params.inputData, params.metadata),
    };
  }
}
