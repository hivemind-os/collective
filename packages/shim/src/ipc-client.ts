import { randomUUID } from 'node:crypto';
import net from 'node:net';

declare const PKG_VERSION: string;
const SHIM_VERSION = PKG_VERSION;

type MessageHandler = (message: object) => void;
type CloseHandler = () => void;

export interface HelloResult {
  daemonVersion?: string;
  connectionId?: string;
}

export class IpcClient {
  private socket?: net.Socket;
  private buffer = '';
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private helloId?: string;
  private helloWaiter?: { resolve: (result: HelloResult) => void; reject: (error: Error) => void };

  constructor(private readonly ipcPath: string) {}

  async connect(appName = 'unknown'): Promise<HelloResult> {
    this.close();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const client = net.connect(this.ipcPath, () => {
        client.off('error', reject);
        resolve(client);
      });
      client.once('error', reject);
    });

    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.drainBuffer();
    });
    socket.on('close', () => {
      this.handleClose();
    });
    socket.on('end', () => {
      this.handleClose();
    });
    socket.on('error', () => undefined);

    this.helloId = `shim-hello-${randomUUID()}`;
    return new Promise<HelloResult>((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
      this.send({
        jsonrpc: '2.0',
        id: this.helloId as string,
        method: 'shim_hello',
        params: {
          appName,
          pid: process.pid,
          shimVersion: SHIM_VERSION,
          ...(process.env.COLLECTIVE_PROFILE ? { profile: process.env.COLLECTIVE_PROFILE } : {}),
        },
      });
    });
  }

  send(message: object): void {
    this.sendRaw(JSON.stringify(message));
  }

  sendRaw(line: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('IPC client is not connected');
    }

    socket.write(`${line.trimEnd()}\n`);
  }

  onMessage(handler: (message: object) => void): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = '';
    this.rejectHello(new Error('IPC connection closed'));
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (this.helloWaiter && message.id === this.helloId) {
          const waiter = this.helloWaiter;
          this.helloWaiter = undefined;
          this.helloId = undefined;
          if (message.error && typeof message.error === 'object') {
            waiter.reject(new Error(String((message.error as { message?: unknown }).message ?? 'shim_hello failed')));
          } else {
            const result = (message.result ?? {}) as Record<string, unknown>;
            waiter.resolve({
              daemonVersion: typeof result.daemonVersion === 'string' ? result.daemonVersion : undefined,
              connectionId: typeof result.connectionId === 'string' ? result.connectionId : undefined,
            });
          }
        } else {
          for (const handler of this.messageHandlers) {
            handler(message);
          }
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleClose(): void {
    if (!this.socket && !this.helloWaiter) {
      return;
    }

    this.socket = undefined;
    this.buffer = '';
    this.rejectHello(new Error('IPC connection closed'));
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  private rejectHello(error: Error): void {
    if (!this.helloWaiter) {
      return;
    }

    const waiter = this.helloWaiter;
    this.helloWaiter = undefined;
    this.helloId = undefined;
    waiter.reject(error);
  }
}
