import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';

import type { RelayConfig } from '../config.js';
import { HealthMonitor } from '../health/monitor.js';
import { RelayIdentity } from '../identity/relay-identity.js';
import { PaymentGate } from '../payment/payment-gate.js';
import { RelayRegistryService, type RelayRegistryRuntime } from '../registry/relay-registry-service.js';
import { parseProviderMessage, serializeRelayMessage } from '../routing/message-types.js';
import { RelayRouter } from '../routing/router.js';
import { SessionManager } from '../routing/session-manager.js';
import { registerMeshMiddleware } from './middleware.js';
import { registerRelayRoutes } from './routes.js';

const RELAY_VERSION = '0.1.0';

export interface RelayServer {
  app: FastifyInstance;
  config: RelayConfig;
  identity: RelayIdentity;
  sessionManager: SessionManager;
  router: RelayRouter;
  paymentGate: PaymentGate;
  healthMonitor: HealthMonitor;
  relayRegistry?: RelayRegistryRuntime;
  start: () => Promise<string>;
}

export interface RelayServerOptions {
  relayRegistry?: RelayRegistryRuntime;
}

export async function createRelayServer(config: RelayConfig, options: RelayServerOptions = {}): Promise<RelayServer> {
  const app = Fastify({
    logger: {
      level: 'info',
    },
  });
  const identity = RelayIdentity.load(config.identity.keyPath);
  const sessionManager = new SessionManager({
    maxConnections: config.limits.maxConnections,
    heartbeatTimeoutMs: config.limits.heartbeatTimeoutMs,
    authNonceTtlMs: config.limits.authNonceTtlMs,
  });
  const router = new RelayRouter({
    sessionManager,
    taskTimeoutMs: config.limits.taskTimeoutMs,
  });
  const paymentGate = new PaymentGate({
    relayDid: identity.did,
    feeSchedule: config.fees,
  });
  const healthMonitor = new HealthMonitor({
    getConnectedProviders: () => sessionManager.getConnectedProviders().length,
  });
  const relayRegistry = options.relayRegistry ?? new RelayRegistryService(config, identity);

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowedOrigins = config.cors?.allowedOrigins ?? [];
      if (!origin) {
        callback(null, false);
        return;
      }

      callback(null, allowedOrigins.includes(origin));
    },
  });
  app.register(rateLimit, {
    max: config.limits.maxRequestsPerSecond,
    timeWindow: '1 second',
  });
  await app.register(websocket);
  registerMeshMiddleware(app, identity.did);
  await registerRelayRoutes(app, {
    relayDid: identity.did,
    version: RELAY_VERSION,
    config,
    sessionManager,
    router,
    paymentGate,
    healthMonitor,
    relayRegistry,
  });

  app.get('/v1/ws', { websocket: true }, (socket) => {
    attachProviderSocket({
      ws: normalizeWebSocket(socket),
      identity,
      sessionManager,
      router,
    });
  });

  const heartbeatSweep = setInterval(() => {
    sessionManager.sweepExpiredSessions();
    paymentGate.pruneExpiredChallenges();
  }, Math.max(1_000, Math.floor(config.limits.heartbeatIntervalMs / 2)));

  app.addHook('onClose', async () => {
    clearInterval(heartbeatSweep);
    await relayRegistry.stop();
    router.close();
    sessionManager.disconnectAllSessions();
  });

  await app.ready();

  return {
    app,
    config,
    identity,
    sessionManager,
    router,
    paymentGate,
    healthMonitor,
    relayRegistry,
    start: async () => {
      const address = await app.listen({ host: config.host, port: config.port });
      const resolvedAddress = typeof address === 'string' ? address : `http://${config.host}:${config.port}`;
      await relayRegistry.start(resolvedAddress);
      return resolvedAddress;
    },
  };
}

function attachProviderSocket(params: {
  ws: WebSocket;
  identity: RelayIdentity;
  sessionManager: SessionManager;
  router: RelayRouter;
}): void {
  let authenticatedSessionId: string | undefined;
  const authTimeout = setTimeout(() => {
    if (authenticatedSessionId) {
      return;
    }

    safeSend(params.ws, serializeRelayMessage({ type: 'auth_fail', reason: 'Authentication timeout.' }));
    safeClose(params.ws, 4003, 'Authentication timeout');
  }, 5_000);

  params.ws.on('message', (payload) => {
    const message = parseProviderMessage(payload);
    if (!message) {
      clearTimeout(authTimeout);
      safeSend(params.ws, serializeRelayMessage({ type: 'auth_fail', reason: 'Invalid relay message.' }));
      safeClose(params.ws, 4004, 'Invalid relay message');
      return;
    }

    if (!authenticatedSessionId) {
      if (message.type !== 'auth') {
        clearTimeout(authTimeout);
        safeSend(params.ws, serializeRelayMessage({ type: 'auth_fail', reason: 'Authentication required.' }));
        safeClose(params.ws, 4005, 'Authentication required');
        return;
      }

      try {
        const session = params.sessionManager.registerSession(params.ws, message);
        authenticatedSessionId = session.sessionId;
        clearTimeout(authTimeout);
        safeSend(
          params.ws,
          serializeRelayMessage({
            type: 'auth_ok',
            sessionId: session.sessionId,
            relayDid: params.identity.did,
          }),
        );
      } catch (error) {
        clearTimeout(authTimeout);
        safeSend(
          params.ws,
          serializeRelayMessage({
            type: 'auth_fail',
            reason: error instanceof Error ? error.message : 'Authentication failed.',
          }),
        );
        safeClose(params.ws, 4006, 'Authentication failed');
      }
      return;
    }

    if (message.type === 'auth') {
      safeSend(params.ws, serializeRelayMessage({ type: 'auth_fail', reason: 'Session already authenticated.' }));
      return;
    }

    if (message.type === 'heartbeat') {
      if (message.sessionId !== authenticatedSessionId) {
        safeClose(params.ws, 4007, 'Session mismatch');
        return;
      }

      params.sessionManager.handleHeartbeat(authenticatedSessionId);
      safeSend(params.ws, serializeRelayMessage({ type: 'heartbeat_ack' }));
      return;
    }

    try {
      params.router.handleProviderMessage(authenticatedSessionId, message);
    } catch (error) {
      safeClose(params.ws, 4008, error instanceof Error ? error.message : 'Provider message rejected');
    }
  });

  const cleanup = () => {
    clearTimeout(authTimeout);
    if (authenticatedSessionId) {
      params.sessionManager.removeSession(authenticatedSessionId);
    }
  };

  params.ws.once('close', cleanup);
  params.ws.once('error', cleanup);
}

function normalizeWebSocket(socket: WebSocket | { socket?: WebSocket }): WebSocket {
  if (
    'on' in socket &&
    typeof socket.on === 'function' &&
    'send' in socket &&
    typeof socket.send === 'function' &&
    'close' in socket &&
    typeof socket.close === 'function'
  ) {
    return socket;
  }

  if ('socket' in socket && socket.socket) {
    return socket.socket;
  }

  throw new Error('Fastify websocket route did not provide a WebSocket connection.');
}

function safeSend(ws: WebSocket, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(message);
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  ws.close(code, reason);
}
