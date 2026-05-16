import type { ExecutionAdapter } from './interface.js';

export interface WebhookAdapterConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export class WebhookAdapter implements ExecutionAdapter {
  readonly name = 'webhook';
  private readonly url: URL;
  private readonly method: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(config: WebhookAdapterConfig) {
    this.url = parseUrl(config.url);
    this.method = (config.method ?? 'POST').toUpperCase();
    if (!BODY_METHODS.has(this.method)) {
      throw new Error(`Webhook method must be one of POST, PUT, PATCH (got ${this.method})`);
    }
    this.headers = { ...config.headers };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: this.method,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Mesh-Task-Id': params.taskId,
          'X-Mesh-Capability': params.capability,
          ...this.headers,
        },
        body: params.inputData,
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Webhook returned redirect (HTTP ${response.status}) which is not followed for security`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const truncated = body.length > 256 ? body.slice(0, 256) + '...' : body;
        throw new Error(`Webhook returned HTTP ${response.status}: ${truncated}`);
      }

      const resultData = await readLimitedResponse(response, this.maxResponseBytes);
      return { resultData };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Webhook timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Webhook response too large: ${contentLength} bytes (max ${maxBytes})`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  if (!response.body) {
    return new Uint8Array(0);
  }

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Webhook response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid webhook URL: ${input}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Webhook URL must use http or https: ${input}`);
  }

  return url;
}
