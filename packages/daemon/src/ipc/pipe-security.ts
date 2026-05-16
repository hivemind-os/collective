import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LEGACY_WINDOWS_PIPE_PATH = '\\\\.\\pipe\\agentic-mesh';

export interface PipeSecurityRuntime {
  platform?: NodeJS.Platform;
  username?: string;
  runPowerShell?: (script: string) => Promise<string>;
}

export interface PipeAclSummary {
  owner?: string;
  identities: string[];
}

export interface PipeSecurityStatus {
  transport: 'windows-pipe' | 'unix-socket';
  userScoped: boolean;
  aclVerified: boolean;
  acl?: PipeAclSummary;
  note: string;
}

export interface ClientValidationResult {
  allowed: boolean;
  source: 'windows-pid' | 'unix-socket';
  reason?: string;
  expectedUser?: string;
  actualUser?: string;
}

export function getDefaultIpcPath(dataDir: string, runtime: PipeSecurityRuntime = {}): string {
  return getPlatform(runtime) === 'win32' ? buildWindowsUserPipePath(runtime.username) : join(dataDir, 'mesh.sock');
}

export function buildWindowsUserPipePath(username = getCurrentUsername()): string {
  return `${LEGACY_WINDOWS_PIPE_PATH}-${sanitizePipeSegment(username)}`;
}

export function isLegacyWindowsPipePath(ipcPath: string): boolean {
  return ipcPath.toLowerCase() === LEGACY_WINDOWS_PIPE_PATH.toLowerCase();
}

export async function verifyPipeSecurity(
  ipcPath: string,
  runtime: PipeSecurityRuntime = {},
): Promise<PipeSecurityStatus> {
  if (getPlatform(runtime) !== 'win32') {
    return {
      transport: 'unix-socket',
      userScoped: true,
      aclVerified: false,
      note: 'Unix IPC isolation relies on socket permissions (chmod 0o600).',
    };
  }

  if (isLegacyWindowsPipePath(ipcPath)) {
    return {
      transport: 'windows-pipe',
      userScoped: false,
      aclVerified: false,
      note: 'Legacy shared Windows pipe name configured; prefer the per-user default pipe name.',
    };
  }

  try {
    const acl = await inspectWindowsPipeAcl(ipcPath, runtime);
    return {
      transport: 'windows-pipe',
      userScoped: true,
      aclVerified: true,
      acl,
      note: 'Using a user-scoped Windows named pipe.',
    };
  } catch (error) {
    return {
      transport: 'windows-pipe',
      userScoped: true,
      aclVerified: false,
      note: `Using a user-scoped Windows named pipe. ACL inspection was unavailable: ${getErrorMessage(error)}`,
    };
  }
}

export async function validateClientProcessOwnership(
  pid: number,
  runtime: PipeSecurityRuntime = {},
): Promise<ClientValidationResult> {
  if (!Number.isInteger(pid) || pid < 0) {
    return {
      allowed: false,
      source: 'windows-pid',
      reason: `Invalid client PID: ${pid}`,
    };
  }

  if (getPlatform(runtime) !== 'win32') {
    return {
      allowed: true,
      source: 'unix-socket',
    };
  }

  const expectedUser = runtime.username ?? getCurrentUsername();

  try {
    const owner = await readWindowsProcessOwner(pid, runtime);
    const actualUser = owner.domain ? `${owner.domain}\\${owner.user}` : owner.user;
    if (!owner.user) {
      return {
        allowed: false,
        source: 'windows-pid',
        expectedUser,
        reason: `Unable to determine the owner of process ${pid}.`,
      };
    }

    if (normalizeUserName(owner.user) !== normalizeUserName(expectedUser)) {
      return {
        allowed: false,
        source: 'windows-pid',
        expectedUser,
        actualUser,
        reason: `Process ${pid} is owned by ${actualUser}, expected ${expectedUser}.`,
      };
    }

    return {
      allowed: true,
      source: 'windows-pid',
      expectedUser,
      actualUser,
    };
  } catch (error) {
    return {
      allowed: false,
      source: 'windows-pid',
      expectedUser,
      reason: `Unable to validate client process ${pid}: ${getErrorMessage(error)}`,
    };
  }
}

function sanitizePipeSegment(value: string): string {
  const leaf = value.split(/[\\/]+/).filter(Boolean).at(-1) ?? value;
  const sanitized = leaf.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'unknown-user';
}

function normalizeUserName(value: string): string {
  const leaf = value.split('\\').filter(Boolean).at(-1) ?? value;
  return leaf.trim().toLowerCase();
}

function getCurrentUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown-user';
  }
}

function getPlatform(runtime: PipeSecurityRuntime): NodeJS.Platform {
  return runtime.platform ?? process.platform;
}

async function inspectWindowsPipeAcl(ipcPath: string, runtime: PipeSecurityRuntime): Promise<PipeAclSummary> {
  const stdout = await runPowerShell(
    [
      `$path = '${escapePowerShellString(ipcPath)}'`,
      '$acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
      '$identities = @($acl.Access | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)',
      '[pscustomobject]@{ owner = $acl.Owner; identities = $identities } | ConvertTo-Json -Compress -Depth 4',
    ].join('; '),
    runtime,
  );
  const parsed = parseJson(stdout) as { owner?: unknown; identities?: unknown };

  return {
    owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
    identities: Array.isArray(parsed.identities)
      ? parsed.identities.filter((identity): identity is string => typeof identity === 'string')
      : [],
  };
}

async function readWindowsProcessOwner(
  pid: number,
  runtime: PipeSecurityRuntime,
): Promise<{ user?: string; domain?: string }> {
  const stdout = await runPowerShell(
    [
      `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
      'if ($null -eq $process) { throw \"Process not found.\" }',
      '$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop',
      'if ($null -eq $owner -or [string]::IsNullOrWhiteSpace($owner.User)) { throw \"Process owner is unavailable.\" }',
      '[pscustomobject]@{ user = $owner.User; domain = $owner.Domain } | ConvertTo-Json -Compress',
    ].join('; '),
    runtime,
  );
  const parsed = parseJson(stdout) as { user?: unknown; domain?: unknown };
  return {
    user: typeof parsed.user === 'string' ? parsed.user : undefined,
    domain: typeof parsed.domain === 'string' ? parsed.domain : undefined,
  };
}

async function runPowerShell(script: string, runtime: PipeSecurityRuntime): Promise<string> {
  if (runtime.runPowerShell) {
    return runtime.runPowerShell(script);
  }

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true },
  );
  return stdout.trim();
}

function parseJson(value: string): unknown {
  if (!value.trim()) {
    throw new Error('PowerShell command returned no output.');
  }

  return JSON.parse(value) as unknown;
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
