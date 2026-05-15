import { pathToFileURL } from 'node:url';

import { loadRelayConfig } from './config.js';
import { createRelayServer } from './server/http-server.js';

export * from './config.js';
export * from './server/http-server.js';
export * from './server/middleware.js';
export * from './server/routes.js';
export * from './routing/message-types.js';
export * from './routing/router.js';
export * from './routing/session-manager.js';
export * from './payment/payment-gate.js';
export * from './payment/fee-schedule.js';
export * from './identity/relay-identity.js';
export * from './health/monitor.js';

export async function startRelayServer() {
  const config = loadRelayConfig();
  const relay = await createRelayServer(config);
  const address = await relay.start();
  return { relay, address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { relay, address } = await startRelayServer();
    relay.app.log.info({ address, relayDid: relay.identity.did }, 'Relay server started');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
