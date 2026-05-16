import { loadMeshConfig } from './config.js';
import {
  getDaemonAuthStatus,
  requestDaemonReauth,
  type DaemonAuthStatus,
  type DaemonReauthResponse,
} from '../utils/daemon-client.js';
import { info, success, warn } from '../utils/output.js';

export interface AuthCommandDeps {
  getAuthStatus: (ipcPath: string) => Promise<DaemonAuthStatus>;
  triggerReauth: (ipcPath: string) => Promise<DaemonReauthResponse>;
}

const defaultDeps: AuthCommandDeps = {
  getAuthStatus: getDaemonAuthStatus,
  triggerReauth: requestDaemonReauth,
};

export async function handleAuth(
  subcommand?: string,
  _args: string[] = [],
  deps: AuthCommandDeps = defaultDeps,
): Promise<number> {
  switch (subcommand) {
    case 'status':
      return await showAuthStatus(deps);
    case 'reauth':
      return await triggerReauth(deps);
    default:
      throw new Error('Usage: mesh auth <status|reauth>');
  }
}

async function showAuthStatus(deps: AuthCommandDeps): Promise<number> {
  const status = await deps.getAuthStatus(loadMeshConfig().daemon.ipcPath);
  printAuthStatus(status);
  return status.authenticated ? 0 : 1;
}

async function triggerReauth(deps: AuthCommandDeps): Promise<number> {
  const result = await deps.triggerReauth(loadMeshConfig().daemon.ipcPath);
  printAuthStatus(result.status);
  if (result.portalUrl) {
    if (result.browserOpened) {
      success(`Opened re-auth portal: ${result.portalUrl}`);
    } else {
      warn(`Open the re-auth portal manually: ${result.portalUrl}`);
    }
  } else {
    info('This daemon auth mode does not require browser re-authentication.');
  }

  return result.status.authenticated ? 0 : 1;
}

function printAuthStatus(status: DaemonAuthStatus): void {
  const expires = formatExpiry(status.expiresAt);
  const stateLabel = status.authenticated ? status.state : `${status.state} (action required)`;

  console.log(`Auth Mode: ${status.authMode}`);
  console.log(`State: ${stateLabel}`);
  console.log(`Address: ${status.address ?? '-'}`);
  console.log(`Expires: ${expires}`);
  console.log(`Refresh Available: ${status.refreshAvailable ? 'yes' : 'no'}`);
  if (status.lastError) {
    console.log(`Last Error: ${status.lastError}`);
  }
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) {
    return 'unknown';
  }

  return new Date(expiresAt).toISOString();
}
