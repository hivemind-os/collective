export interface ConnectedApp {
  connectionId: string;
  appName: string;
  appPid: number;
  profile?: string;
  connectedAt: number;
}

export interface ConnectedAppMetadata {
  appName: string;
  appPid: number;
  profile?: string;
}

interface ConnectionEntry {
  connectionId: string;
  connectedAt: number;
  appName?: string;
  appPid?: number;
  profile?: string;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();

  registerConnection(connectionId: string, connectedAt = Date.now()): void {
    this.connections.set(connectionId, {
      connectionId,
      connectedAt,
    });
  }

  updateConnection(connectionId: string, metadata: ConnectedAppMetadata): ConnectedApp {
    const current = this.connections.get(connectionId);
    const next: ConnectionEntry = {
      connectionId,
      connectedAt: current?.connectedAt ?? Date.now(),
      appName: metadata.appName,
      appPid: metadata.appPid,
      profile: metadata.profile,
    };

    this.connections.set(connectionId, next);
    return toConnectedApp(next);
  }

  unregisterConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  getConnectedApps(): ConnectedApp[] {
    return Array.from(this.connections.values())
      .filter(isConnectedApp)
      .map(toConnectedApp)
      .sort((left, right) => left.connectedAt - right.connectedAt);
  }
}

function isConnectedApp(entry: ConnectionEntry): entry is ConnectedApp {
  return typeof entry.appName === 'string' && typeof entry.appPid === 'number';
}

function toConnectedApp(entry: ConnectionEntry): ConnectedApp {
  if (!isConnectedApp(entry)) {
    throw new Error(`Connection ${entry.connectionId} is missing app metadata.`);
  }

  return {
    connectionId: entry.connectionId,
    connectedAt: entry.connectedAt,
    appName: entry.appName,
    appPid: entry.appPid,
    profile: entry.profile,
  };
}
