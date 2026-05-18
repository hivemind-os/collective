import type { CreateMessageRequest, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';

import type { ExecutionAdapter } from './interface.js';

/**
 * Narrow interface for MCP sampling. The provider runtime supplies an implementation
 * that looks up the correct connected MCP client and sends the sampling request.
 * This avoids exposing the full MCP Server to adapter code.
 */
export type McpSamplingFn = (
  appName: string,
  params: CreateMessageRequest['params'],
) => Promise<CreateMessageResult>;

export interface McpSamplingAdapterConfig {
  appName: string;
  systemPrompt: string;
  maxTokens?: number;
  modelHint?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export class McpSamplingAdapter implements ExecutionAdapter {
  readonly name = 'mcp-sampling';
  private readonly appName: string;
  private readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly modelHint: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    config: McpSamplingAdapterConfig,
    private readonly sample: McpSamplingFn,
  ) {
    if (!config.appName || config.appName.trim().length === 0) {
      throw new Error('MCP sampling adapter requires a non-empty appName');
    }
    if (!config.systemPrompt || config.systemPrompt.trim().length === 0) {
      throw new Error('MCP sampling adapter requires a non-empty systemPrompt');
    }

    this.appName = config.appName.trim();
    this.systemPrompt = config.systemPrompt;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.modelHint = config.modelHint;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    let inputText: string;
    try {
      inputText = decoder.decode(params.inputData);
    } catch {
      throw new Error('MCP sampling adapter requires valid UTF-8 input');
    }

    const samplingParams: CreateMessageRequest['params'] = {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: inputText },
        },
      ],
      systemPrompt: this.systemPrompt,
      maxTokens: this.maxTokens,
      ...(this.modelHint
        ? { modelPreferences: { hints: [{ name: this.modelHint }] } }
        : {}),
    };

    const result = await Promise.race([
      this.sample(this.appName, samplingParams),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP sampling timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
      ),
    ]);

    const text = extractTextContent(result);
    if (text === undefined) {
      throw new Error('MCP sampling response contained no text content');
    }

    return {
      resultData: encoder.encode(text),
      metadata: {
        model: result.model,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      },
    };
  }
}

function extractTextContent(result: CreateMessageResult): string | undefined {
  const content = result.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        return block.text;
      }
    }
    return undefined;
  }

  if (content.type === 'text') {
    return content.text;
  }

  return undefined;
}
