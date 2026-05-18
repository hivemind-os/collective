/**
 * Playwright tests for the HiveMind Collective portal UI.
 *
 * These tests start a real PortalServer on a random port, then use Playwright
 * to render and interact with the pages in a headless browser.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { test, expect } from '@playwright/test';

import { getDefaultConfig, saveConfig, type DaemonFullConfig } from '@hivemind-os/collective-daemon/config';
import { PortalServer } from '@hivemind-os/collective-daemon/portal/server';

const ARTIFACTS_ROOT = resolve(process.cwd(), '.artifacts', 'playwright');

interface PortalFixture {
  portal: PortalServer;
  baseUrl: string;
  config: DaemonFullConfig;
  configPath: string;
  cleanup: () => Promise<void>;
}

async function createPortalFixture(options?: {
  providerConfig?: DaemonFullConfig['provider'];
}): Promise<PortalFixture> {
  const id = randomUUID().slice(0, 8);
  const baseDir = join(ARTIFACTS_ROOT, id);
  await mkdir(baseDir, { recursive: true });

  const defaults = getDefaultConfig();
  const config: DaemonFullConfig = {
    ...defaults,
    network: {
      ...defaults.network,
      rpcUrl: 'http://127.0.0.1:9000',
    },
    identity: { dataDir: join(baseDir, 'identity') },
    auth: {
      mode: 'ed25519',
      portal: { port: 0 },
    },
    daemon: {
      ...defaults.daemon,
      dataDir: join(baseDir, 'daemon'),
      pidFile: join(baseDir, 'daemon.pid'),
      ipcPath: `\\\\.\\pipe\\hivemind-collective-pw-${id}`,
    },
    blobstore: {
      mode: 'filesystem',
      filesystem: { dataDir: join(baseDir, 'blobs') },
    },
    provider: options?.providerConfig,
  };

  const configPath = join(baseDir, 'config.yaml');
  await saveConfig(config, configPath);

  const portal = new PortalServer({ config, configPath });
  const baseUrl = await portal.start();

  return {
    portal,
    baseUrl,
    config,
    configPath,
    cleanup: async () => {
      await portal.stop();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

test.describe('Portal UI — layout and navigation', () => {
  let fixture: PortalFixture;

  test.beforeAll(async () => {
    fixture = await createPortalFixture();
  });

  test.afterAll(async () => {
    await fixture?.cleanup();
  });

  test('renders sidebar with navigation links', async ({ page }) => {
    await page.goto(fixture.baseUrl);
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    const navItems = sidebar.locator('.nav__item');
    const count = await navItems.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Check brand
    await expect(sidebar.locator('.brand')).toContainText('HiveMind Collective');
  });

  test('Settings page is active by default', async ({ page }) => {
    await page.goto(fixture.baseUrl);
    const activeNav = page.locator('.nav__item.is-active');
    await expect(activeNav).toHaveAttribute('href', '/');
    await expect(activeNav).toContainText('Settings');
  });

  test('navigates to Services page', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);
    const activeNav = page.locator('.nav__item.is-active');
    await expect(activeNav).toContainText('Services');
    await expect(page.locator('h1')).toContainText('Provider services');
  });

  test('navigates to Wallet page', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/wallet`);
    const activeNav = page.locator('.nav__item.is-active');
    await expect(activeNav).toContainText('Wallet');
  });

  test('navigates to Discover page', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/discover`);
    const activeNav = page.locator('.nav__item.is-active');
    await expect(activeNav).toContainText('Discover');
  });

  test('navigates to Network page', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/network`);
    const activeNav = page.locator('.nav__item.is-active');
    await expect(activeNav).toContainText('Network');
  });
});

test.describe('Portal UI — Services management', () => {
  let fixture: PortalFixture;

  test.beforeAll(async () => {
    fixture = await createPortalFixture({
      providerConfig: {
        enabled: true,
        autoRegister: false,
        maxConcurrency: 2,
        capabilities: [
          {
            name: 'calculator',
            description: 'Basic math operations',
            version: '1.0.0',
            priceMist: 1000,
            adapter: 'echo',
          },
        ],
      },
    });
  });

  test.afterAll(async () => {
    await fixture?.cleanup();
  });

  test('loads provider config and displays capabilities', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);

    // Wait for provider config to load
    await page.waitForSelector('#provider-config:not([hidden])', { timeout: 5000 });

    // Provider enabled toggle should be checked
    const enabledToggle = page.locator('#provider-enabled');
    await expect(enabledToggle).toBeChecked();

    // Max concurrency
    const maxConcurrency = page.locator('#provider-max-concurrency');
    await expect(maxConcurrency).toHaveValue('2');

    // Should show 1 capability
    await expect(page.locator('#capability-summary')).toContainText('1 configured');
    await expect(page.locator('.capability-list')).toContainText('calculator');
  });

  test('can toggle provider enabled off and save', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);
    await page.waitForSelector('#provider-config:not([hidden])', { timeout: 5000 });

    // Uncheck provider enabled (checkbox is hidden inside a custom switch)
    await page.locator('#provider-enabled').evaluate((el: HTMLInputElement) => {
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Save
    await page.locator('#save-provider').click();

    // Wait for success notice
    await page.waitForSelector('#provider-notice.notice--success:not([hidden])', { timeout: 5000 });

    // Verify via API
    const res = await fetch(`${fixture.baseUrl}/api/provider/config`);
    const data = await res.json();
    expect(data.enabled).toBe(false);

    // Re-enable for subsequent tests
    await page.locator('#provider-enabled').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#save-provider').click();
    await page.waitForSelector('#provider-notice.notice--success:not([hidden])', { timeout: 5000 });
  });

  test('can add a new capability via the form', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);
    await page.waitForSelector('#provider-config:not([hidden])', { timeout: 5000 });

    // Fill out the capability form
    await page.locator('#capability-name').fill('summarize');
    await page.locator('#capability-description').fill('Summarize text content');
    await page.locator('#capability-version').fill('2.0.0');
    await page.locator('#capability-price-mist').fill('5000');
    await page.locator('#capability-adapter').selectOption('mcp-sampling');

    // Wait for adapter fields to render
    await page.waitForSelector('#adapter-mcp-app-name', { timeout: 2000 });
    await page.locator('#adapter-mcp-app-name').fill('test-agent');
    await page.locator('#adapter-mcp-system-prompt').fill('You are a summarizer.');

    // Save capability to local list
    await page.locator('#save-capability').click();

    // Should now show 2 capabilities
    await expect(page.locator('#capability-summary')).toContainText('2 configured');
    await expect(page.locator('.capability-list')).toContainText('summarize');

    // Save to server
    await page.locator('#save-provider').click();
    await page.waitForSelector('#provider-notice.notice--success:not([hidden])', { timeout: 5000 });

    // Verify via API
    const res = await fetch(`${fixture.baseUrl}/api/provider/config`);
    const data = await res.json();
    expect(data.capabilities).toHaveLength(2);
    expect(data.capabilities[1].name).toBe('summarize');
    expect(data.capabilities[1].adapter).toBe('mcp-sampling');
    expect(data.capabilities[1].adapterConfig?.appName).toBe('test-agent');
  });

  test('can delete a capability', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);
    await page.waitForSelector('#provider-config:not([hidden])', { timeout: 5000 });

    // Find and click the delete button for the second capability
    const deleteButtons = page.locator('button[data-action="delete"]');
    const count = await deleteButtons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Delete the second one (summarize)
    await deleteButtons.nth(1).click();

    // Should now show 1 capability
    await expect(page.locator('#capability-summary')).toContainText('1 configured');

    // Save
    await page.locator('#save-provider').click();
    await page.waitForSelector('#provider-notice.notice--success:not([hidden])', { timeout: 5000 });

    // Verify
    const res = await fetch(`${fixture.baseUrl}/api/provider/config`);
    const data = await res.json();
    expect(data.capabilities).toHaveLength(1);
    expect(data.capabilities[0].name).toBe('calculator');
  });

  test('rejects invalid adapter config', async ({ page }) => {
    await page.goto(`${fixture.baseUrl}/services`);
    await page.waitForSelector('#provider-config:not([hidden])', { timeout: 5000 });

    // Try to add a webhook capability without URL
    await page.locator('#capability-name').fill('bad-webhook');
    await page.locator('#capability-description').fill('test');
    await page.locator('#capability-version').fill('1.0.0');
    await page.locator('#capability-price-mist').fill('100');
    await page.locator('#capability-adapter').selectOption('webhook');

    // Wait for adapter fields
    await page.waitForSelector('#adapter-webhook-url', { timeout: 2000 });
    // Don't fill URL — leave it empty

    // Try to save capability
    await page.locator('#save-capability').click();

    // Should show error notice in provider-notice element
    await page.waitForSelector('#provider-notice.notice--error:not([hidden])', { timeout: 3000 });
    const notice = page.locator('#provider-notice');
    await expect(notice).toContainText('URL');
  });
});

test.describe('Portal API — provider config', () => {
  let fixture: PortalFixture;

  test.beforeAll(async () => {
    fixture = await createPortalFixture();
  });

  test.afterAll(async () => {
    await fixture?.cleanup();
  });

  test('GET /api/provider/config returns empty config when not configured', async () => {
    const res = await fetch(`${fixture.baseUrl}/api/provider/config`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.enabled).toBe(false);
    expect(data.capabilities).toEqual([]);
  });

  test('POST /api/provider/config saves valid config', async () => {
    const payload = {
      enabled: true,
      autoRegister: true,
      maxConcurrency: 3,
      capabilities: [
        {
          name: 'test-cap',
          description: 'A test capability',
          version: '1.0.0',
          priceMist: 500,
          adapter: 'echo',
        },
      ],
    };

    const res = await fetch(`${fixture.baseUrl}/api/provider/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify it persisted
    const getRes = await fetch(`${fixture.baseUrl}/api/provider/config`);
    const getBody = await getRes.json();
    expect(getBody.enabled).toBe(true);
    expect(getBody.capabilities).toHaveLength(1);
    expect(getBody.capabilities[0].name).toBe('test-cap');
  });

  test('POST /api/provider/config rejects subprocess without allowSubprocess', async () => {
    const payload = {
      enabled: true,
      capabilities: [
        {
          name: 'risky',
          description: 'Runs commands',
          version: '1.0.0',
          priceMist: 100,
          adapter: 'subprocess',
          adapterConfig: { command: 'rm -rf /' },
        },
      ],
    };

    const res = await fetch(`${fixture.baseUrl}/api/provider/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('subprocess');
  });

  test('POST /api/provider/config rejects missing webhook URL', async () => {
    const payload = {
      enabled: true,
      capabilities: [
        {
          name: 'bad-hook',
          description: 'Missing URL',
          version: '1.0.0',
          priceMist: 100,
          adapter: 'webhook',
          adapterConfig: {},
        },
      ],
    };

    const res = await fetch(`${fixture.baseUrl}/api/provider/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/url/i);
  });
});
