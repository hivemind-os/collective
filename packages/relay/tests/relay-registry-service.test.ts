import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RelayRegistryClient } from '@hivemind-os/collective-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDefaultRelayConfig } from '../src/config.js';
import { RelayIdentity } from '../src/identity/relay-identity.js';
import { RelayRegistryService } from '../src/registry/relay-registry-service.js';

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

describe('RelayRegistryService', () => {
  it('propagates startup failures after recording the last error', async () => {
    const dir = await createTestDir();
    const config = getDefaultRelayConfig(dir);
    config.identity.keyPath = resolve(dir, 'relay.key');
    config.sui = {
      rpcUrl: 'http://127.0.0.1:9000',
      packageId: '0x123',
    };
    config.relayRegistry = {
      enabled: true,
      stakePositionId: '0xabc',
      capabilities: ['weather'],
      heartbeatIntervalMs: 1_000,
    };
    const identity = RelayIdentity.load(config.identity.keyPath);
    const startupError = new Error('registry lookup failed');
    const client = {
      listRelays: vi.fn(async () => {
        throw startupError;
      }),
      getRelay: vi.fn(async () => null),
      registerRelay: vi.fn(async () => ({ relayId: '0xrelay', txDigest: 'digest' })),
      heartbeat: vi.fn(async () => ({ lastHeartbeat: Date.now(), txDigest: 'digest' })),
    } as unknown as RelayRegistryClient;
    const service = new RelayRegistryService(config, identity, client);

    await expect(service.start('http://127.0.0.1:3000')).rejects.toThrow(startupError);
    expect(service.getInfo().lastError).toBe(startupError.message);
  });
});
