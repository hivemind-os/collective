import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';

import pino from 'pino';

import type { DaemonAuthStatus } from '../auth/session-monitor.js';
import type { DaemonStatusBase, DaemonState } from '../state.js';
import { Connection } from './connection.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { MeshToolContext } from '@agentic-mesh/mcp-server';
import { ConnectionRegistry, type ConnectedApp, type ConnectedAppMetadata } from './connection-registry.js';
import {
  validateClientProcessOwnership,
  verifyPipeSecurity,
  type ClientValidationResult,
  type PipeSecurityStatus,
} from './pipe-security.js';

const logger = pino({ name: '@agentic-mesh/daemon:ipc-server' });

export interface DaemonStatusSnapshot extends DaemonStatusBase {
  connectedApps: ConnectedApp[];
}

export interface IpcServerOptions {
  validateClient?: (metadata: ConnectedAppMetadata) => Promise<ClientValidationResult>;
  verifyPipeSecurity?: (ipcPath: string) => Promise<PipeSecurityStatus>;
  getAuthStatus?: () => DaemonAuthStatus;
  triggerReauth?: () => Promise<{ portalUrl: string | null; browserOpened: boolean; status: DaemonAuthStatus }>;
}

export class IpcServer {
  private server?: net.Server;
  private readonly connections = new Map<string, Connection>();
  private readonly connectionRegistry = new ConnectionRegistry();
  toolContext?: MeshToolContext;

  constructor(
    private readonly ipcPath: string,
    private readonly state: DaemonState,
    private readonly options: IpcServerOptions = {},
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
      logger.debug({ ipcPath: this.ipcPath }, 'IPC socket permissions set to 0600 for local-user isolation.');
    } else {
      await this.logPipeSecurity();
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

  getAuthStatus(): DaemonAuthStatus {
    return this.options.getAuthStatus?.() ?? {
      authMode: this.state.authProvider.mode,
      authenticated: this.state.authProvider.isAuthenticated(),
      state: this.state.authProvider.isAuthenticated() ? 'authenticated' : 'reauth_required',
      address: this.state.authProvider.isAuthenticated() ? this.state.address : null,
      expiresAt: null,
      expiresInMs: null,
      refreshAvailable: false,
      lastError: null,
      updatedAt: Date.now(),
    };
  }

  notifyAuthStatusChanged(status = this.getAuthStatus()): void {
    for (const connection of this.connections.values()) {
      connection.sendNotification('auth.status_changed', status);
    }
  }

  /**
   * Broadcast a notification to all connected MCP sessions.
   * Used for provider inbound task notifications and other system-wide events.
   */
  broadcastNotification(method: string, params?: unknown): void {
    for (const connection of this.connections.values()) {
      connection.sendNotification(method, params);
    }
  }

  /**
   * Look up the low-level MCP Server for a connected app by name.
   * Throws if multiple connections match (ambiguous).
   * Returns undefined if no match is found.
   */
  getMcpServerForApp(appName: string): Server | undefined {
    const matches: Connection[] = [];
    for (const connection of this.connections.values()) {
      if (connection.connectedAppName === appName) {
        matches.push(connection);
      }
    }

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous MCP sampling target: ${matches.length} connections match appName "${appName}". ` +
          'Use a more specific identifier or disconnect duplicate clients.',
      );
    }

    return matches[0]?.mcpServer;
  }

  private handleConnection(socket: net.Socket): void {
    logger.info({ ipcPath: this.ipcPath }, 'Received IPC connection attempt.');

    const connection = new Connection(socket, this.state, {
      getStatus: () => this.getStatus(),
      getAuthStatus: () => this.getAuthStatus(),
      triggerReauth: () => this.options.triggerReauth?.() ?? Promise.resolve({ portalUrl: null, browserOpened: false, status: this.getAuthStatus() }),
      validateClient: (metadata) => this.validateClient(metadata),
      toolContext: this.toolContext,
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

  private async logPipeSecurity(): Promise<void> {
    try {
      const inspectPipeSecurity = this.options.verifyPipeSecurity ?? verifyPipeSecurity;
      const status = await inspectPipeSecurity(this.ipcPath);
      const bindings = {
        ipcPath: this.ipcPath,
        userScoped: status.userScoped,
        aclVerified: status.aclVerified,
        owner: status.acl?.owner,
        identities: status.acl?.identities,
      };

      if (!status.userScoped) {
        logger.warn(bindings, status.note);
        return;
      }

      if (!status.aclVerified) {
        logger.debug(bindings, status.note);
        return;
      }

      logger.info(bindings, status.note);
    } catch (error) {
      logger.warn({ err: error, ipcPath: this.ipcPath }, 'Failed to inspect Windows pipe security.');
    }
  }

  private async validateClient(metadata: ConnectedAppMetadata): Promise<ClientValidationResult> {
    if (process.platform !== 'win32') {
      return {
        allowed: true,
        source: 'unix-socket',
      };
    }

    const validateClientProcess = this.options.validateClient ?? ((client) => validateClientProcessOwnership(client.appPid));
    const validation = await validateClientProcess(metadata);
    if (!validation.allowed) {
      logger.warn(
        {
          ipcPath: this.ipcPath,
          appName: metadata.appName,
          appPid: metadata.appPid,
          expectedUser: validation.expectedUser,
          actualUser: validation.actualUser,
          reason: validation.reason,
        },
        'Rejected IPC client during Windows identity validation.',
      );
    }

    return validation;
  }
}
