import net from 'node:net';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface DaemonStatus {
  version?: string;
  did: string;
  address: string;
  uptimeMs: number;
  uptime?: number;
  connectedApps: Array<{
    connectionId: string;
    appName?: string;
    pid?: number;
    profile?: string;
    connectedAt: number;
  }>;
}

export interface DaemonAuthStatus {
  authMode: string;
  authenticated: boolean;
  state: string;
  address: string | null;
  expiresAt: number | null;
  expiresInMs: number | null;
  refreshAvailable: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface DaemonReauthResponse {
  portalUrl: string | null;
  browserOpened: boolean;
  status: DaemonAuthStatus;
}

export class DaemonClient {
  private buffer = '';
  private readonly pending = new Map<string | number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private nextId = 0;

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });
    socket.on('error', (error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on('close', () => {
      this.rejectPending(new Error('Daemon IPC connection closed.'));
    });
  }

  static async connect(ipcPath: string): Promise<DaemonClient> {
    const socket = await new Promise<net.Socket>((resolvePromise, reject) => {
      const client = net.connect(ipcPath, () => {
        client.off('error', reject);
        resolvePromise(client);
      });
      client.once('error', reject);
    });

    const daemonClient = new DaemonClient(socket);
    await daemonClient.initialize();
    return daemonClient;
  }

  async getStatus(): Promise<DaemonStatus> {
    return (await this.callTool('collective_status', {})) as DaemonStatus;
  }

  async getAuthStatus(): Promise<DaemonAuthStatus> {
    return (await this.request('auth.status')).result as DaemonAuthStatus;
  }

  async triggerReauth(): Promise<DaemonReauthResponse> {
    return (await this.request('auth.reauth')).result as DaemonReauthResponse;
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      this.socket.once('close', () => {
        resolvePromise();
      });
      this.socket.end();
      setTimeout(() => {
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
      }, 25);
    });
  }

  private async initialize(): Promise<void> {
    await this.request('shim_hello', {
      appName: 'mesh-cli',
      pid: process.pid,
      profile: process.env.USERPROFILE ?? process.env.HOME,
    });
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'mesh-cli',
        version: '0.1.0',
      },
    });
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.request('tools/call', {
      name,
      arguments: args,
    });
    const result = asRecord(response.result);
    return result.structuredContent ?? result;
  }

  private request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = `mesh-cli-${++this.nextId}`;
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<JsonRpcResponse>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.write(`${JSON.stringify(message)}\n`);
    }).then((response) => {
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response;
    });
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        if ('id' in message && message.id !== null) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

export async function getDaemonStatus(ipcPath: string): Promise<DaemonStatus> {
  const client = await DaemonClient.connect(ipcPath);
  try {
    return await client.getStatus();
  } finally {
    await client.close();
  }
}

export async function getDaemonAuthStatus(ipcPath: string): Promise<DaemonAuthStatus> {
  const client = await DaemonClient.connect(ipcPath);
  try {
    return await client.getAuthStatus();
  } finally {
    await client.close();
  }
}

export async function requestDaemonReauth(ipcPath: string): Promise<DaemonReauthResponse> {
  const client = await DaemonClient.connect(ipcPath);
  try {
    return await client.triggerReauth();
  } finally {
    await client.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Unexpected daemon response payload.');
  }

  return value as Record<string, unknown>;
}
