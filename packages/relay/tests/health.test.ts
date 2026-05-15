import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDID, generateKeypair, signString } from '@agentic-mesh/core';
import type { DID } from '@agentic-mesh/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { getDefaultRelayConfig } from '../src/config.js';
import { HealthMonitor } from '../src/health/monitor.js';
import type { RelayRegistryRuntime } from '../src/registry/relay-registry-service.js';
import { createAuthPayload, type AuthMessage } from '../src/routing/message-types.js';
import { createRelayServer } from '../src/server/http-server.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createAuthMessage(capabilities: string[]): { did: DID; authMessage: AuthMessage } {
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  const authMessage: AuthMessage = {
    type: 'auth',
    did,
    nonce: 'health-nonce',
    capabilities,
    signature: signString(createAuthPayload({ did, nonce: 'health-nonce', capabilities }), keypair.secretKey),
  };

  return { did, authMessage };
}

describe('health monitoring', () => {
  it('returns the health endpoint payload', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');

    const relay = await createRelayServer(config);
    const response = await relay.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      connectedProviders: 0,
      totalRequestsServed: 0,
    });

    await relay.app.close();
  });

  it('reports the connected provider count accurately', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');

    const relay = await createRelayServer(config);
    const provider = createAuthMessage(['weather']);
    relay.sessionManager.registerSession({
      once: () => undefined,
      close: () => undefined,
    } as unknown as WebSocket, provider.authMessage);

    const response = await relay.app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toMatchObject({ connectedProviders: 1 });

    await relay.app.close();
  });

  it('includes relay registry info in health output', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');
    const relayRegistry: RelayRegistryRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      recordRouting: vi.fn(async () => undefined),
      getInfo: vi.fn(() => ({ enabled: true, registered: true, relayId: '0xrelay', status: 'ACTIVE', totalRouted: 4 })),
    };

    const relay = await createRelayServer(config, { relayRegistry });
    const response = await relay.app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toMatchObject({
      relayRegistry: {
        enabled: true,
        registered: true,
        relayId: '0xrelay',
        status: 'ACTIVE',
        totalRouted: 4,
      },
    });

    await relay.app.close();
  });

  it('starts the relay registry runtime after listening', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');
    const relayRegistry: RelayRegistryRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      recordRouting: vi.fn(async () => undefined),
      getInfo: vi.fn(() => ({ enabled: true, registered: false })),
    };

    const relay = await createRelayServer(config, { relayRegistry });
    const address = await relay.start();

    expect(relayRegistry.start).toHaveBeenCalledWith(address);

    await relay.app.close();
  });

  it('tracks uptime over time', () => {
    let now = 10_000;
    const monitor = new HealthMonitor({ now: () => now, getConnectedProviders: () => 1 });

    now = 14_250;

    expect(monitor.getStatus()).toMatchObject({
      status: 'healthy',
      uptime: 4_250,
      connectedProviders: 1,
    });
  });

  it('does not emit permissive CORS headers by default', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');

    const relay = await createRelayServer(config);
    const response = await relay.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await relay.app.close();
  });

  it('allows configured CORS origins', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.host = '127.0.0.1';
    config.port = 0;
    config.identity.keyPath = resolve(dir, 'relay.key');
    config.cors = { allowedOrigins: ['https://console.example'] };

    const relay = await createRelayServer(config);
    const response = await relay.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://console.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://console.example');

    await relay.app.close();
  });
});
