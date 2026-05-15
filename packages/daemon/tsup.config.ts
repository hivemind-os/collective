import { defineConfig } from 'tsup';

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
});
