import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Ed25519AuthProvider, ReputationEventPublisher } from '../../src/index.js';
import { serializeReputationEventPayload } from '../../src/reputation/serialization.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('ReputationEventPublisher', () => {
  it('rejects self-authored reputation events', async () => {
    await createTempDir();
    const keypair = Ed25519Keypair.generate();
    const identity = new Ed25519AuthProvider(keypair);
    const publisher = new ReputationEventPublisher({ store: vi.fn() } as never, identity);

    await expect(publisher.createEvent({
      type: 'task_completion',
      subject: identity.getDID(),
      taskId: 'task-1',
      outcome: 'success',
      capability: 'echo',
    })).rejects.toThrow('Reputation event subject must differ from author.');
  });

  it('creates signed reputation events and publishes them', async () => {
    await createTempDir();
    const keypair = Ed25519Keypair.generate();
    const identity = new Ed25519AuthProvider(keypair);
    const blobStore = {
      store: vi.fn(async () => ({ blobId: 'blob-1', hash: 'hash', checksum: 'hash', contentHash: 'hash', size: 1, storedAt: Date.now() })),
    } as never;
    const publisher = new ReputationEventPublisher(blobStore, identity);

    const event = await publisher.createEvent({
      type: 'task_completion',
      subject: 'did:mesh:provider',
      taskId: 'task-1',
      outcome: 'success',
      capability: 'echo',
      rating: 5,
      latencyMs: 123,
      paymentAmount: { amount: '42', currency: 'MIST' },
    });

    expect(event.author).toBe(identity.getDID());
    expect(event.signature.length).toBeGreaterThan(0);
    const { signature, ...unsignedEvent } = event;
    await expect(
      keypair.getPublicKey().verifyPersonalMessage(serializeReputationEventPayload(unsignedEvent), signature),
    ).resolves.toBe(true);

    await publisher.publishEvent(event);
    expect(blobStore.store).toHaveBeenCalledOnce();
  });
});
