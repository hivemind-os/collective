export interface ExecutionAdapter {
  readonly name: string;

  execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{
    resultData: Uint8Array;
    metadata?: Record<string, string>;
  }>;
}
