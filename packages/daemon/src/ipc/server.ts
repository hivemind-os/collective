import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';

import pino from 'pino';

import type { DaemonStatusBase, DaemonState } from '../state.js';
import { Connection } from './connection.js';
import { ConnectionRegistry, type ConnectedApp } from './connection-registry.js';

const logger = pino({ name: '@agentic-mesh/daemon:ipc-server' });

export interface DaemonStatusSnapshot extends DaemonStatusBase {
  connectedApps: ConnectedApp[];
}

export class IpcServer {
  private server?: net.Server;
  private readonly connections = new Map<string, Connection>();
  private readonly connectionRegistry = new ConnectionRegistry();

  constructor(
    private readonly ipcPath: string,
    private readonly state: DaemonState,
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    if (process.platform !== 'win32') {
      await rm(this.ipcPath, { force: true });
    }

    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      if (process.platform === 'win32') {
        server.listen(this.ipcPath, () => {
          server.off('error', reject);
          resolvePromise();
        });
        return;
      }

      server.listen({ path: this.ipcPath, readableAll: false, writableAll: false }, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });

    if (process.platform !== 'win32') {
      await chmod(this.ipcPath, 0o600);
    }

    server.on('error', (error) => {
      logger.error({ err: error }, 'IPC server error.');
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = undefined;
    for (const connection of [...this.connections.values()]) {
      connection.close();
    }

    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise();
      });
    });

    if (process.platform !== 'win32') {
      await rm(this.ipcPath, { force: true });
    }
  }

  getConnectedApps(): ConnectedApp[] {
    return this.connectionRegistry.getConnectedApps();
  }

  getStatus(): DaemonStatusSnapshot {
    return {
      ...this.state.getStatusBase(),
      connectedApps: this.getConnectedApps(),
    };
  }

  private handleConnection(socket: net.Socket): void {
    const connection = new Connection(socket, this.state, {
      getStatus: () => this.getStatus(),
      onHello: (metadata) => {
        this.connectionRegistry.updateConnection(connection.id, metadata);
      },
      onClose: () => {
        this.connections.delete(connection.id);
        this.connectionRegistry.unregisterConnection(connection.id);
      },
    });

    this.connections.set(connection.id, connection);
    this.connectionRegistry.registerConnection(connection.id, connection.connectedAt);
  }
}
