import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ZkLoginProvider, ZkLoginSessionStore } from '@agentic-mesh/core';
import type { SuiClient } from '@mysten/sui/client';
import { type DaemonFullConfig, getDefaultConfig } from '@agentic-mesh/daemon/config';
import { PortalServer } from '@agentic-mesh/daemon/portal/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { MockOidcProvider, PortAllocator } from '../harness/index.js';
import { createArtifactDir, createArtifactRoot, removeDirectoryWithRetries } from './test-helpers.js';

let artifactRoot: string;

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
});

describe('Phase 1 Beta E2E: Portal integration', () => {
  it('starts on a random port and serves the setup landing page plus status JSON', async () => {
    artifactRoot ??= await createArtifactRoot('portal-e2e');
    const harness = await startPortalHarness();

    try {
      const landing = await fetch(harness.portalUrl);
      const status = await fetch(`${harness.portalUrl}/api/status`);
      const statusBody = (await status.json()) as Record<string, unknown>;

      expect(landing.ok).toBe(true);
      expect(await landing.text()).toContain('Welcome to Agentic Mesh');
      expect(statusBody).toMatchObject({
        authenticated: false,
        authMode: 'zklogin',
        setupComplete: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('completes the mock OAuth callback flow and notifies the daemon on authentication', async () => {
    artifactRoot ??= await createArtifactRoot('portal-e2e');
    const onAuthenticated = vi.fn();
    const harness = await startPortalHarness({ onAuthenticated });

    try {
      const callbackHtml = await authenticateViaPortal(harness.portalUrl);
      const status = await fetch(`${harness.portalUrl}/api/status`);
      const statusBody = (await status.json()) as Record<string, unknown>;

      expect(callbackHtml).toContain('Finish setup');
      expect(harness.authProvider.isAuthenticated()).toBe(true);
      expect(statusBody.authenticated).toBe(true);
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
      expect(onAuthenticated.mock.calls[0]?.[0]).toMatchObject({
        address: await harness.authProvider.getAddress(),
        refreshToken: 'mock-refresh-token',
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('persists setup settings, resolves waitForAuth, and serves the ready state', async () => {
    artifactRoot ??= await createArtifactRoot('portal-e2e');
    const onSettingsSaved = vi.fn();
    const harness = await startPortalHarness({ onSettingsSaved });

    try {
      await authenticateViaPortal(harness.portalUrl);
      const waitForCompletion = harness.portal.waitForAuth();
      const finish = await fetch(`${harness.portalUrl}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyLimitSui: '7' }),
      });
      const finishBody = (await finish.json()) as Record<string, unknown>;

      await waitForCompletion;

      const status = await fetch(`${harness.portalUrl}/api/status`);
      const statusBody = (await status.json()) as Record<string, unknown>;
      const readyPage = await fetch(harness.portalUrl);
      const readyHtml = await readyPage.text();

      expect(finish.ok).toBe(true);
      expect(finishBody.spendingLimitMist).toBe('7000000000');
      expect(statusBody.setupComplete).toBe(true);
      expect(statusBody.spendingLimitMist).toBe('7000000000');
      expect(onSettingsSaved).toHaveBeenCalledTimes(1);
      expect(readyHtml).toContain('Agentic Mesh is ready');
    } finally {
      await harness.cleanup();
    }
  });

  it('shuts down gracefully and stops accepting connections', async () => {
    artifactRoot ??= await createArtifactRoot('portal-e2e');
    const harness = await startPortalHarness();

    await harness.portal.stop();
    await harness.oidc.stop();
    await harness.portAllocator.release([harness.portalPort, harness.oidcPort]);

    await expect(fetch(harness.portalUrl)).rejects.toThrow();
  });
});

async function startPortalHarness(params: {
  onAuthenticated?: (session: unknown) => void | Promise<void>;
  onSettingsSaved?: (config: DaemonFullConfig) => void | Promise<void>;
} = {}) {
  const portAllocator = new PortAllocator();
  const [portalPort, oidcPort] = await portAllocator.allocate(2);
  const baseDir = await createArtifactDir(artifactRoot ?? (artifactRoot = await createArtifactRoot('portal-e2e')), 'portal');
  const oidc = new MockOidcProvider({ aud: 'portal-client-id', sub: 'portal-user' });
  await oidc.start(oidcPort);

  const defaults = getDefaultConfig();
  const config: DaemonFullConfig = {
    ...defaults,
    network: {
      ...defaults.network,
      rpcUrl: 'http://127.0.0.1:9000',
    },
    identity: {
      dataDir: join(baseDir, 'identity'),
    },
    auth: {
      mode: 'zklogin',
      google: {
        clientId: 'portal-client-id',
      },
      portal: {
        port: portalPort,
      },
    },
    daemon: {
      ...defaults.daemon,
      dataDir: join(baseDir, 'daemon'),
      pidFile: join(baseDir, 'daemon.pid'),
      ipcPath: `\\\\.\\pipe\\agentic-mesh-portal-${randomUUID()}`,
    },
    blobstore: {
      mode: 'filesystem',
      filesystem: {
        dataDir: join(baseDir, 'blobs'),
      },
    },
  };

  const authProvider = new ZkLoginProvider({
    client: {
      getCurrentEpoch: async () => ({ epoch: '7' } as Awaited<ReturnType<SuiClient['getCurrentEpoch']>>),
    },
    oauth: {
      ...oidc.oauthConfig,
      clientId: 'portal-client-id',
      redirectUri: '',
    },
    sessionStore: new ZkLoginSessionStore(join(baseDir, 'sessions'), new Uint8Array([1, 3, 3, 7])),
  });
  const portal = new PortalServer({
    config,
    authProvider,
    onAuthenticated: params.onAuthenticated,
    onSettingsSaved: params.onSettingsSaved,
  });
  const portalUrl = await portal.start();

  return {
    portal,
    portalUrl,
    portalPort,
    oidc,
    oidcPort,
    portAllocator,
    authProvider,
    config,
    cleanup: async () => {
      await portal.stop();
      await oidc.stop();
      await portAllocator.release([portalPort, oidcPort]);
    },
  };
}

async function authenticateViaPortal(portalUrl: string): Promise<string> {
  const authRedirect = await fetch(`${portalUrl}/auth/google`, { redirect: 'manual' });
  const providerRedirect = authRedirect.headers.get('location');
  if (!providerRedirect) {
    throw new Error('Portal did not redirect to the OIDC provider.');
  }

  const callbackRedirect = await fetch(providerRedirect, { redirect: 'manual' });
  const callbackUrl = callbackRedirect.headers.get('location');
  if (!callbackUrl) {
    throw new Error('OIDC provider did not redirect back to the portal callback.');
  }

  const callbackPage = await fetch(callbackUrl);
  return await callbackPage.text();
}
