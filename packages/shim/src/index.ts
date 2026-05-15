#!/usr/bin/env node

import { startShim } from './bridge.js';

startShim().catch((err) => {
  process.stderr.write(`mesh-shim fatal: ${err.message}\n`);
  process.exit(1);
});
