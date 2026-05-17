import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/config.ts',
    'src/state.ts',
    'src/provider/index.ts',
    'src/ipc/server.ts',
    'src/portal/server.ts',
    'src/relay/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  define: {
    'PKG_VERSION': JSON.stringify(version),
  },
});
