import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { parseDID, verify } from '@agentic-mesh/core';
import type { DID } from '@agentic-mesh/types';
import type WebSocket from 'ws';

import { createAuthPayload, normalizeCapability, type AuthMessage } from './message-types.js';

export interface ProviderSession {
  sessionId: string;
  providerDid: DID;
  ws: WebSocket;
  capabilities: string[];
  connectedAt: number;
  lastHeartbeat: number;
  sequenceCounter: number;
}

export interface ProviderInfo {
  sessionId: string;
  providerDid: DID;
  capabilities: string[];
  connectedAt: number;
  lastHeartbeat: number;
}

interface ManagedProviderSession extends ProviderSession {
  normalizedCapabilities: string[];
}

export interface SessionManagerOptions {
  maxConnections: number;
  heartbeatTimeoutMs: number;
  authNonceTtlMs?: number;
  now?: () => number;
}

const encoder = new TextEncoder();

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedProviderSession>();
  private readonly sessionsByDid = new Map<DID, Set<string>>();
  private readonly capabilityIndex = new Map<string, Set<string>>();
  private readonly inboundSequences = new Map<string, number>();
  private readonly capabilityCursor = new Map<string, number>();
  private readonly recentAuthNonces = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: SessionManagerOptions) {
    super();
    this.now = options.now ?? (() => Date.now());
  }

  registerSession(ws: WebSocket, authMessage: AuthMessage): ProviderSession {
    if (this.sessions.size >= this.options.maxConnections) {
      throw new Error('Relay connection limit reached.');
    }

    this.pruneRecentAuthNonces();
    if (this.getSessionByDid(authMessage.did)) {
      throw new Error(`Provider ${authMessage.did} is already connected to the relay.`);
    }

    this.verifyAuthMessage(authMessage);
    this.markAuthNonceUsed(authMessage);

    const sessionId = randomUUID();
    const timestamp = this.now();
    const normalizedCapabilities = [...new Set(authMessage.capabilities.map(normalizeCapability))];
    const session: ManagedProviderSession = {
      sessionId,
      providerDid: authMessage.did,
      ws,
      capabilities: [...normalizedCapabilities],
      normalizedCapabilities,
      connectedAt: timestamp,
      lastHeartbeat: timestamp,
      sequenceCounter: 0,
    };

    this.sessions.set(sessionId, session);
    this.addDidIndex(session.providerDid, sessionId);
    this.addCapabilities(sessionId, normalizedCapabilities);

    const cleanup = () => {
      this.removeSession(sessionId);
    };

    ws.once('close', cleanup);
    ws.once('error', cleanup);

    this.emit('session_registered', this.toProviderInfo(session));
    return session;
  }

  findProvider(capability: string, preferredDid?: DID): ProviderSession | null {
    const normalizedCapability = normalizeCapability(capability);
    if (preferredDid) {
      return this.getSessionByDid(preferredDid, normalizedCapability);
    }

    const ids = [...(this.capabilityIndex.get(normalizedCapability) ?? [])];
    if (ids.length === 0) {
      return null;
    }

    const cursor = this.capabilityCursor.get(normalizedCapability) ?? 0;
    const sessionId = ids[cursor % ids.length];
    this.capabilityCursor.set(normalizedCapability, cursor + 1);

    return sessionId ? this.sessions.get(sessionId) ?? null : null;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);
    this.inboundSequences.delete(sessionId);
    this.removeDidIndex(session.providerDid, sessionId);
    this.removeCapabilities(sessionId, session.normalizedCapabilities);
    this.emit('session_removed', this.toProviderInfo(session));
  }

  disconnectSession(sessionId: string, code = 4001, reason = 'Session expired'): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      session.ws.close(code, reason);
    } catch {
      this.removeSession(sessionId);
    }
  }

  disconnectAllSessions(code = 1012, reason = 'Relay shutting down'): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disconnectSession(sessionId, code, reason);
    }
  }

  handleHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.lastHeartbeat = this.now();
  }

  sweepExpiredSessions(): string[] {
    this.pruneRecentAuthNonces();
    const now = this.now();
    const expired = [...this.sessions.values()]
      .filter((session) => now - session.lastHeartbeat > this.options.heartbeatTimeoutMs)
      .map((session) => session.sessionId);

    for (const sessionId of expired) {
      this.disconnectSession(sessionId, 4002, 'Heartbeat timeout');
    }

    return expired;
  }

  getConnectedProviders(): ProviderInfo[] {
    return [...this.sessions.values()].map((session) => this.toProviderInfo(session));
  }

  getSession(sessionId: string): ProviderSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getSessionByDid(did: DID, capability?: string): ProviderSession | null {
    const sessionIds = [...(this.sessionsByDid.get(did) ?? [])];
    if (sessionIds.length === 0) {
      return null;
    }

    const normalizedCapability = capability ? normalizeCapability(capability) : undefined;
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }

      if (!normalizedCapability || session.normalizedCapabilities.includes(normalizedCapability)) {
        return session;
      }
    }

    return null;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  nextSequence(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown relay session: ${sessionId}`);
    }

    session.sequenceCounter += 1;
    return session.sequenceCounter;
  }

  validateIncomingSequence(sessionId: string, sequence: number): boolean {
    const previous = this.inboundSequences.get(sessionId) ?? 0;
    if (!Number.isInteger(sequence) || sequence <= previous) {
      return false;
    }

    this.inboundSequences.set(sessionId, sequence);
    return true;
  }

  private verifyAuthMessage(authMessage: AuthMessage): void {
    if (this.recentAuthNonces.has(this.getAuthNonceKey(authMessage))) {
      throw new Error('Authentication nonce has already been used.');
    }

    try {
      const payload = createAuthPayload(authMessage);
      const signature = decodeHex(authMessage.signature);
      const publicKey = parseDID(authMessage.did).publicKey;

      if (!verify(encoder.encode(payload), signature, publicKey)) {
        throw new Error('Invalid provider authentication signature.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Authentication nonce has already been used.') {
        throw error;
      }
      throw new Error('Invalid provider authentication signature.');
    }
  }

  private markAuthNonceUsed(authMessage: AuthMessage): void {
    this.recentAuthNonces.set(this.getAuthNonceKey(authMessage), this.now() + this.getAuthNonceTtlMs());
  }

  private pruneRecentAuthNonces(): void {
    const now = this.now();
    for (const [nonceKey, expiresAt] of this.recentAuthNonces.entries()) {
      if (expiresAt > now) {
        continue;
      }

      this.recentAuthNonces.delete(nonceKey);
    }
  }

  private getAuthNonceKey(authMessage: Pick<AuthMessage, 'did' | 'nonce'>): string {
    return `${authMessage.did}:${authMessage.nonce}`;
  }

  private getAuthNonceTtlMs(): number {
    return this.options.authNonceTtlMs ?? 5 * 60_000;
  }

  private addDidIndex(did: DID, sessionId: string): void {
    const ids = this.sessionsByDid.get(did) ?? new Set<string>();
    ids.add(sessionId);
    this.sessionsByDid.set(did, ids);
  }

  private removeDidIndex(did: DID, sessionId: string): void {
    const ids = this.sessionsByDid.get(did);
    if (!ids) {
      return;
    }

    ids.delete(sessionId);
    if (ids.size === 0) {
      this.sessionsByDid.delete(did);
    }
  }

  private addCapabilities(sessionId: string, capabilities: string[]): void {
    for (const capability of capabilities) {
      const sessions = this.capabilityIndex.get(capability) ?? new Set<string>();
      sessions.add(sessionId);
      this.capabilityIndex.set(capability, sessions);
    }
  }

  private removeCapabilities(sessionId: string, capabilities: string[]): void {
    for (const capability of capabilities) {
      const sessions = this.capabilityIndex.get(capability);
      if (!sessions) {
        continue;
      }

      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.capabilityIndex.delete(capability);
        this.capabilityCursor.delete(capability);
      }
    }
  }

  private toProviderInfo(session: ManagedProviderSession): ProviderInfo {
    return {
      sessionId: session.sessionId,
      providerDid: session.providerDid,
      capabilities: [...session.capabilities],
      connectedAt: session.connectedAt,
      lastHeartbeat: session.lastHeartbeat,
    };
  }
}

function decodeHex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('Authentication signature must be a hex string.');
  }

  return Uint8Array.from(Buffer.from(value, 'hex'));
}
