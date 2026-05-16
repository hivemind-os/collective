import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  LEGACY_WINDOWS_PIPE_PATH,
  getDefaultIpcPath,
  validateClientProcessOwnership,
  verifyPipeSecurity,
} from '../src/ipc/pipe-security.js';

describe('pipe security', () => {
  it('builds a per-user Windows pipe path', () => {
    expect(getDefaultIpcPath('C:\\mesh', { platform: 'win32', username: 'DOMAIN\\Alice Smith' })).toBe(
      '\\\\.\\pipe\\agentic-mesh-alice-smith',
    );
  });

  it('keeps unix socket defaults inside the data directory', () => {
    expect(getDefaultIpcPath('mesh-root', { platform: 'linux', username: 'alice' })).toBe(join('mesh-root', 'mesh.sock'));
  });

  it('flags the legacy shared Windows pipe name', async () => {
    await expect(verifyPipeSecurity(LEGACY_WINDOWS_PIPE_PATH, { platform: 'win32' })).resolves.toMatchObject({
      transport: 'windows-pipe',
      userScoped: false,
      aclVerified: false,
    });
  });

  it('captures ACL details for a user-scoped Windows pipe', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(
      JSON.stringify({ owner: 'WORKSTATION\\Alice', identities: ['WORKSTATION\\Alice'] }),
    );

    await expect(
      verifyPipeSecurity('\\\\.\\pipe\\agentic-mesh-alice', { platform: 'win32', runPowerShell }),
    ).resolves.toMatchObject({
      transport: 'windows-pipe',
      userScoped: true,
      aclVerified: true,
      acl: {
        owner: 'WORKSTATION\\Alice',
        identities: ['WORKSTATION\\Alice'],
      },
    });
  });

  it('accepts Windows clients owned by the current user', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(JSON.stringify({ user: 'Alice', domain: 'WORKSTATION' }));

    await expect(
      validateClientProcessOwnership(42, { platform: 'win32', username: 'alice', runPowerShell }),
    ).resolves.toMatchObject({
      allowed: true,
      source: 'windows-pid',
      actualUser: 'WORKSTATION\\Alice',
    });
  });

  it('rejects Windows clients owned by another user', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(JSON.stringify({ user: 'Bob', domain: 'WORKSTATION' }));

    await expect(
      validateClientProcessOwnership(42, { platform: 'win32', username: 'alice', runPowerShell }),
    ).resolves.toMatchObject({
      allowed: false,
      source: 'windows-pid',
      actualUser: 'WORKSTATION\\Bob',
    });
  });
});
