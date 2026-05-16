import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { FilesystemBlobStore, MeshSuiClient, RegistryClient, TaskClient, ZkLoginProvider, ZkLoginSessionStore } from '@hivemind-os/collective-core';
import type { SuiClient } from '@mysten/sui/client';
import { type DaemonFullConfig, getDefaultConfig, saveConfig } from '@hivemind-os/collective-daemon/config';
import { type PortalAuthProvider, PortalServer } from '@hivemind-os/collective-daemon/portal/server';
import { DaemonState, buildOAuthConfig, createDaemonIdentityContext } from '@hivemind-os/collective-daemon/state';
import { TaskStatus } from '@hivemind-os/collective-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PortAllocator, SuiTestNetwork } from '../harness/index.js';
import {
  buildEchoResult,
  createArtifactDir,
  createArtifactRoot,
  createCapability,
  createNetworkConfig,
  defaultDisputeWindowMs,
  defaultPriceMist,
  postTaskWithBlobStore,
  removeDirectoryWithRetries,
  requestFromFaucet,
  waitForCondition,
  waitForTaskStatus,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

beforeAll(async () => {
  artifactRoot = await createArtifactRoot('auth-switching');
  network = new SuiTestNetwork();
  await network.start();
}, 120_000);

afterAll(async () => {
  await network?.stop();
  await removeDirectoryWithRetries(artifactRoot);
}, 30_000);

describe('Phase 1 Beta E2E: Auth mode switching', () => {
  it('runs the daemon end-to-end in Ed25519 mode for register, discover, post, accept, complete, and release', async () => {
    const baseDir = await createArtifactDir(artifactRoot, 'daemon-ed25519');
    const config = createDaemonConfig(baseDir, { mode: 'ed25519' });
    const identityContext = await createDaemonIdentityContext(config);
    const daemonAddress = await identityContext.authProvider.getAddress();

    await requestFromFaucet(network.faucetUrl, daemonAddress, 3_000_000_000n);

    const state = await DaemonState.create(config, identityContext);
    try {
      const consumer = await network.createFundedWallet();
      const networkConfig = createNetworkConfig(network);
      const consumerRegistryClient = new RegistryClient(new MeshSuiClient(networkConfig), networkConfig);
      const consumerTaskClient = new TaskClient(new MeshSuiClient(networkConfig), networkConfig);
      const sharedBlobStore = new FilesystemBlobStore(join(baseDir, 'shared-blobs'));

      const { agentCardId } = await state.registryClient.registerAgent({
        name: 'Daemon Echo Provider',
        did: state.did,
        description: 'Ed25519 daemon identity for beta E2E tests',
        capabilities: [createCapability({ name: 'echo' })],
        endpoint: 'mesh://daemon/echo',
        keypair: state.keypair,
      });

      const discoveredAgents = await waitForCondition(async () => {
        const agents = await consumerRegistryClient.discoverByCapability('echo');
        return agents.some((agent) => agent.id === agentCardId) ? agents : undefined;
      }, 15_000, 'Ed25519 daemon registration was not discoverable');

      const posted = await postTaskWithBlobStore({
        taskClient: consumerTaskClient,
        blobStore: sharedBlobStore,
        input: 'ed25519 daemon lifecycle payload',
        capability: 'echo',
        priceMist: defaultPriceMist,
        disputeWindowMs: defaultDisputeWindowMs,
        expiryHours: 1,
        keypair: consumer.keypair,
      });

      await state.taskClient.acceptTask({ taskId: posted.taskId, keypair: state.keypair });
      const accepted = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.ACCEPTED);
      const resultData = buildEchoResult(posted.taskId, 'echo', posted.inputData);
      const { blobId: resultBlobId } = await sharedBlobStore.store(resultData);

      await state.taskClient.completeTask({ taskId: posted.taskId, resultBlobId, keypair: state.keypair });
      const completed = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.COMPLETED);
      await consumerTaskClient.releasePayment({ taskId: posted.taskId, keypair: consumer.keypair });
      const released = await waitForTaskStatus(consumerTaskClient, posted.taskId, TaskStatus.RELEASED);

      expect(state.authProvider.mode).toBe('ed25519');
      expect(discoveredAgents.some((agent) => agent.did === state.did)).toBe(true);
      expect(accepted.provider).toBe(state.address);
      expect(completed.resultBlobId).toBe(resultBlobId);
      expect(released.resultBlobId).toBe(resultBlobId);
    } finally {
      await state.shutdown();
    }
  }, 60_000);

  it('starts the first-run portal flow when zkLogin mode has no stored session', async () => {
    const baseDir = await createArtifactDir(artifactRoot, 'daemon-zklogin');
    const portAllocator = new PortAllocator();
    const [portalPort] = await portAllocator.allocate(1);
    const config = createDaemonConfig(baseDir, {
      mode: 'zklogin',
      portalPort,
      googleClientId: 'zklogin-beta-client',
    });

    const configPath = join(baseDir, 'hivemind-collective.config.yaml');
    await saveConfig(config, configPath);

    const authProvider = new ZkLoginProvider({
      client: {
        getCurrentEpoch: async () => ({ epoch: '7' } as Awaited<ReturnType<SuiClient['getCurrentEpoch']>>),
      },
      oauth: buildOAuthConfig(config),
      sessionStore: new ZkLoginSessionStore(join(baseDir, 'sessions'), new Uint8Array([1, 2, 3, 4])),
    });
    const portal = new PortalServer({
      config,
      configPath,
      authProvider: authProvider as PortalAuthProvider,
    });

    try {
      const portalUrl = await portal.start();
      const landing = await fetch(portalUrl);
      const status = await fetch(`${portalUrl}/api/status`);
      const statusBody = (await status.json()) as Record<string, unknown>;

      expect(authProvider.mode).toBe('zklogin');
      expect(authProvider.isAuthenticated()).toBe(false);
      expect(await landing.text()).toContain('Welcome to Agentic Mesh');
      expect(statusBody).toMatchObject({ authenticated: false, authMode: 'zklogin', setupComplete: false });
    } finally {
      await portal.stop();
      await portAllocator.release([portalPort]);
    }
  });
});

function createDaemonConfig(
  baseDir: string,
  params: { mode: 'ed25519' | 'zklogin'; portalPort?: number; googleClientId?: string },
): DaemonFullConfig {
  const defaults = getDefaultConfig();

  return {
    ...defaults,
    network: createNetworkConfig(network),
    identity: {
      dataDir: join(baseDir, 'identity'),
    },
    auth:
      params.mode === 'zklogin'
        ? {
            mode: 'zklogin',
            google: {
              clientId: params.googleClientId ?? 'zklogin-client-id',
            },
            portal: {
              port: params.portalPort ?? 19876,
            },
          }
        : {
            mode: 'ed25519',
            portal: {
              port: params.portalPort ?? 19876,
            },
          },
    daemon: {
      ...defaults.daemon,
      dataDir: join(baseDir, 'daemon'),
      pidFile: join(baseDir, 'daemon.pid'),
      ipcPath: `\\\\.\\pipe\\hivemind-collective-${randomUUID()}`,
    },
    blobstore: {
      mode: 'filesystem',
      filesystem: {
        dataDir: join(baseDir, 'blobs'),
      },
    },
  };
}
