export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || parsed.jsonrpc !== '2.0') {
      return null;
    }

    if (typeof parsed.method === 'string') {
      if ('id' in parsed) {
        if (typeof parsed.id !== 'string' && typeof parsed.id !== 'number') {
          return null;
        }

        return {
          jsonrpc: '2.0',
          id: parsed.id,
          method: parsed.method,
          params: parsed.params,
        } satisfies JsonRpcRequest;
      }

      return {
        jsonrpc: '2.0',
        method: parsed.method,
        params: parsed.params,
      } satisfies JsonRpcNotification;
    }

    if ('id' in parsed && (typeof parsed.id === 'string' || typeof parsed.id === 'number' || parsed.id === null)) {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: parsed.id as JsonRpcResponse['id'],
      };

      if ('result' in parsed) {
        response.result = parsed.result;
      }

      if ('error' in parsed) {
        const error = parsed.error;
        if (!error || typeof error !== 'object') {
          return null;
        }

        const code = (error as Record<string, unknown>).code;
        const message = (error as Record<string, unknown>).message;
        if (typeof code !== 'number' || typeof message !== 'string') {
          return null;
        }

        response.error = {
          code,
          message,
          data: (error as Record<string, unknown>).data,
        };
      }

      if (!('result' in parsed) && !('error' in parsed)) {
        return null;
      }

      return response;
    }

    return null;
  } catch {
    return null;
  }
}

export function serializeResponse(response: JsonRpcMessage): string {
  return JSON.stringify(response);
}

export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}
