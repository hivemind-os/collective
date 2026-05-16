import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import type { StoredZkLoginSession } from '@hivemind-os/collective-core';

import { SessionMonitor } from '../src/auth/session-monitor.js';

function createJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createSession(expiresAt: number, overrides: Partial<StoredZkLoginSession> = {}): StoredZkLoginSession {
  return {
    provider: 'google',
    jwt: createJwt(Math.floor(expiresAt / 1_000)),
    salt: '12345',
    epoch: 10,
    ephemeralKeypair: Ed25519Keypair.generate(),
    proof: {
      proofPoints: { a: ['1', '2'], b: [['3'], ['4']], c: ['5', '6'] },
      issBase64Details: { value: 'issuer', indexMod4: 0 },
      headerBase64: 'header',
      addressSeed: '98765',
    },
    maxEpoch: 12,
    address: '0x123',
    sub: 'subject-1',
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    randomness: '999',
    refreshToken: 'refresh-token',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('SessionMonitor', () => {
  it('emits expiring and refreshed events when a session is renewed', async () => {
    const now = Date.now();
    const session = createSession(now + 60_000);
    const refreshedSession = createSession(now + 15 * 60_000, { jwt: createJwt(Math.floor((now + 15 * 60_000) / 1_000)), updatedAt: 3 });
    const refreshSessionIfNeeded = vi.fn().mockResolvedValue(refreshedSession);
    const events: string[] = [];
    const provider = {
      mode: 'zklogin' as const,
      isAuthenticated: vi.fn(() => true),
      getSession: vi.fn(() => session),
      getSessionExpiryMs: vi.fn((current?: StoredZkLoginSession | null) => {
        const active = current ?? session;
        return active ? Math.floor(JSON.parse(Buffer.from(active.jwt.split('.')[1] ?? '', 'base64url').toString('utf8')).exp * 1_000) : null;
      }),
      refreshSessionIfNeeded,
      clearSession: vi.fn(),
    };
    const monitor = new SessionMonitor({ authProvider: provider, warningWindowMs: 5 * 60_000 });

    monitor.on('session:expiring', () => events.push('expiring'));
    monitor.on('session:refreshed', () => events.push('refreshed'));

    const status = await monitor.checkNow();

    expect(refreshSessionIfNeeded).toHaveBeenCalledWith(undefined, {
      force: true,
      invalidateOnFailure: true,
      throwOnFailure: true,
    });
    expect(events).toEqual(['expiring', 'refreshed']);
    expect(status.state).toBe('authenticated');
    expect(status.refreshAvailable).toBe(true);
  });

  it('emits expired and reauth_required events when the session is already expired', async () => {
    const session = createSession(Date.now() - 1_000);
    const events: string[] = [];
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const provider = {
      mode: 'zklogin' as const,
      isAuthenticated: vi.fn(() => true),
      getSession: vi.fn(() => session),
      getSessionExpiryMs: vi.fn(() => Date.now() - 1_000),
      refreshSessionIfNeeded: vi.fn(),
      clearSession,
    };
    const monitor = new SessionMonitor({ authProvider: provider });

    monitor.on('session:expired', () => events.push('expired'));
    monitor.on('session:reauth_required', () => events.push('reauth_required'));

    const status = await monitor.checkNow();

    expect(clearSession).toHaveBeenCalledWith(session);
    expect(events).toEqual(['expired', 'reauth_required']);
    expect(status.state).toBe('reauth_required');
    expect(status.authenticated).toBe(false);
  });
});
