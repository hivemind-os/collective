import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/playwright',
  timeout: 30_000,
  retries: 0,
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:0', // overridden per-test by fixture
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
