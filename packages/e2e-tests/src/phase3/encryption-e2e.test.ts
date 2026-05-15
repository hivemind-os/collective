import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  EncryptedBlobStore,
  TaskStatus,
  bytesToHex,
  computeSharedSecret,
  createBlobStore,
  createNetworkConfig,
  createPhase3Clients,
  createArtifactRoot,
  decryptFromSender,
  encryptForRecipient,
  generateX25519KeyPair,
  parseEncryptedPayload,
  registerTestAgent,
  removeDirectoryWithRetries,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 3 E2E: Encryption', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-encryption');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'derives shared secrets, encrypts blobs, decrypts with the correct key, and rejects the wrong key',
    async () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();
      const eve = generateX25519KeyPair();
      const plaintext = new TextEncoder().encode('phase3 confidential payload');

      const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
      const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);
      expect(Buffer.from(aliceShared)).toEqual(Buffer.from(bobShared));

      const payload = await encryptForRecipient(plaintext, alice.privateKey, bob.publicKey);
      expect(payload.ciphertext).not.toContain('phase3 confidential payload');
      expect(bytesToHex(new TextEncoder().encode(JSON.stringify(payload)))).not.toContain(bytesToHex(plaintext));

      const decrypted = await decryptFromSender(payload, bob.privateKey);
      expect(Buffer.from(decrypted)).toEqual(Buffer.from(plaintext));
      await expect(decryptFromSender(payload, eve.privateKey)).rejects.toBeInstanceOf(Error);

      const innerStore = await createBlobStore(artifactRoot, 'encrypted-store');
      const aliceStore = new EncryptedBlobStore(innerStore, alice);
      const bobStore = new EncryptedBlobStore(innerStore, bob);

      const stored = await aliceStore.storeEncrypted(plaintext, bob.publicKey);
      const raw = await innerStore.fetch(stored.blobId);
      const parsed = parseEncryptedPayload(raw ?? new Uint8Array());
      const fetched = await bobStore.fetchDecrypted(stored.blobId);

      expect(raw).toBeTruthy();
      expect(Buffer.from(raw ?? [])).not.toEqual(Buffer.from(plaintext));
      expect(parsed?.senderPublicKey).toBe(bytesToHex(alice.publicKey));
      expect(Buffer.from(fetched ?? [])).toEqual(Buffer.from(plaintext));

      const eveStore = new EncryptedBlobStore(innerStore, eve);
      await expect(eveStore.fetchDecrypted(stored.blobId)).rejects.toBeInstanceOf(Error);
    },
    30_000,
  );

  it(
    'posts encrypted task input that the provider decrypts using its registered X25519 key',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const providerKeyPair = generateX25519KeyPair();
      const requesterKeyPair = generateX25519KeyPair();
      const { clients: providerClients, agentCardId } = await registerTestAgent({
        config,
        wallet: provider,
        capabilityName: 'encrypted-echo',
        name: 'Encrypted Provider',
        encryptionPublicKey: providerKeyPair.publicKey,
      });
      const blobStore = await createBlobStore(artifactRoot, 'encrypted-task-flow');
      const requesterEncryptedStore = new EncryptedBlobStore(blobStore, requesterKeyPair);
      const providerEncryptedStore = new EncryptedBlobStore(blobStore, providerKeyPair);
      const plaintext = new TextEncoder().encode('top secret task instructions');

      const stored = await requesterEncryptedStore.storeEncrypted(plaintext, providerKeyPair.publicKey);
      const raw = await blobStore.fetch(stored.blobId);
      const posted = await requesterClients.task.postTask({
        capability: 'encrypted-echo',
        category: 'secure',
        inputBlobId: stored.blobId,
        priceMist: 250_000_000n,
        disputeWindowMs: 60_000,
        expiryHours: 1,
        keypair: requester.keypair,
      });

      await providerClients.task.acceptTask({ taskId: posted.taskId, keypair: provider.keypair });
      const accepted = await waitForTaskStatus(requesterClients.task, posted.taskId, TaskStatus.ACCEPTED);
      const decrypted = await providerEncryptedStore.fetchDecrypted(stored.blobId);
      const providerCard = await providerClients.registry.getAgentCard(agentCardId);

      expect(Buffer.from(raw ?? [])).not.toEqual(Buffer.from(plaintext));
      expect(Buffer.from(decrypted ?? [])).toEqual(Buffer.from(plaintext));
      expect(providerCard?.encryptionPublicKey).toBe(bytesToHex(providerKeyPair.publicKey));
      expect(accepted.provider).toBe(provider.address);
    },
    60_000,
  );
});
