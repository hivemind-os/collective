import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify(version),
  },
  test: {
    environment: 'node',
    passWithNoTests: false,
  },
});
