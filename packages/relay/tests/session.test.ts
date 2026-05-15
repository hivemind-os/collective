import { EventEmitter } from 'node:events';

import { createDID, generateKeypair, signString } from '@agentic-mesh/core';
import type { DID } from '@agentic-mesh/types';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import { createAuthPayload, type AuthMessage } from '../src/routing/message-types.js';
import { SessionManager } from '../src/routing/session-manager.js';

class TestSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

function createAuthMessage(capabilities: string[]): { did: DID; authMessage: AuthMessage; keypair: ReturnType<typeof generateKeypair> } {
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  const authMessage: AuthMessage = {
    type: 'auth',
    did,
    nonce: 'nonce-1',
    capabilities,
    signature: signString(
      createAuthPayload({
        did,
        nonce: 'nonce-1',
        capabilities,
      }),
      keypair.secretKey,
    ),
  };

  return { did, authMessage, keypair };
}

describe('session manager', () => {
  it('registers an authenticated provider session', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const { did, authMessage } = createAuthMessage(['weather']);

    const session = manager.registerSession(socket as unknown as WebSocket, authMessage);

    expect(session.providerDid).toBe(did);
    expect(session.capabilities).toEqual(['weather']);
    expect(manager.getSessionCount()).toBe(1);
  });

  it('removes a session when the provider disconnects', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const socket = new TestSocket();
    const { authMessage } = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, authMessage);

    socket.close();

    expect(manager.getSession(session.sessionId)).toBeNull();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('expires stale sessions when heartbeats stop', () => {
    let now = 1_000;
    const manager = new SessionManager({
      maxConnections: 5,
      heartbeatTimeoutMs: 5_000,
      now: () => now,
    });
    const socket = new TestSocket();
    const { authMessage } = createAuthMessage(['weather']);
    const session = manager.registerSession(socket as unknown as WebSocket, authMessage);

    now = 3_000;
    manager.handleHeartbeat(session.sessionId);
    now = 9_000;

    const expired = manager.sweepExpiredSessions();

    expect(expired).toEqual([session.sessionId]);
    expect(manager.getSessionCount()).toBe(0);
  });

  it('tracks multiple providers with different capabilities', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const weather = createAuthMessage(['weather']);
    const summarize = createAuthMessage(['summarize']);

    manager.registerSession(new TestSocket() as unknown as WebSocket, weather.authMessage);
    manager.registerSession(new TestSocket() as unknown as WebSocket, summarize.authMessage);

    const providers = manager.getConnectedProviders();

    expect(providers).toHaveLength(2);
    expect(providers.map((provider) => provider.providerDid)).toContain(weather.did);
    expect(providers.map((provider) => provider.providerDid)).toContain(summarize.did);
  });

  it('finds a provider by capability', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const weather = createAuthMessage(['weather']);
    const summarize = createAuthMessage(['summarize']);

    manager.registerSession(new TestSocket() as unknown as WebSocket, weather.authMessage);
    manager.registerSession(new TestSocket() as unknown as WebSocket, summarize.authMessage);

    const provider = manager.findProvider('summarize');

    expect(provider?.providerDid).toBe(summarize.did);
  });

  it('finds a provider by DID', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const provider = createAuthMessage(['weather', 'forecast']);

    const session = manager.registerSession(new TestSocket() as unknown as WebSocket, provider.authMessage);

    expect(manager.getSessionByDid(provider.did)?.sessionId).toBe(session.sessionId);
    expect(manager.findProvider('forecast', provider.did)?.sessionId).toBe(session.sessionId);
  });

  it('rejects a second active connection for the same provider DID', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000 });
    const provider = createAuthMessage(['weather']);
    const duplicateAuth: AuthMessage = {
      type: 'auth',
      did: provider.did,
      nonce: 'nonce-2',
      capabilities: ['weather'],
      signature: signString(
        createAuthPayload({ did: provider.did, nonce: 'nonce-2', capabilities: ['weather'] }),
        provider.keypair.secretKey,
      ),
    };

    manager.registerSession(new TestSocket() as unknown as WebSocket, provider.authMessage);

    expect(() => manager.registerSession(new TestSocket() as unknown as WebSocket, duplicateAuth)).toThrow(
      /already connected/i,
    );
  });

  it('rejects replayed authentication nonces after disconnect', () => {
    const manager = new SessionManager({ maxConnections: 5, heartbeatTimeoutMs: 5_000, authNonceTtlMs: 60_000 });
    const socket = new TestSocket();
    const provider = createAuthMessage(['weather']);

    const session = manager.registerSession(socket as unknown as WebSocket, provider.authMessage);
    manager.removeSession(session.sessionId);

    expect(() => manager.registerSession(new TestSocket() as unknown as WebSocket, provider.authMessage)).toThrow(
      /nonce has already been used/i,
    );
  });
});
