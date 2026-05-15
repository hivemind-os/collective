import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  RelayDiscovery,
  RelayNodeStatus,
  createArtifactRoot,
  createNetworkConfig,
  createPhase4Clients,
  removeDirectoryWithRetries,
  waitForCondition,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 4 E2E: Community relay registry', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase4-relay-registry');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'registers relay nodes on-chain, records heartbeats, rejects external routing metrics, filters active relays, and deactivates a relay',
    async () => {
      const relayEast = await network.createFundedWallet(250_000_000_000n);
      const relayWest = await network.createFundedWallet(250_000_000_000n);
      const config = createNetworkConfig(network);
      const eastClients = createPhase4Clients(config);
      const westClients = createPhase4Clients(config);
      const eastStake = await eastClients.staking.depositStake({
        amountMist: 120_000_000_000n,
        stakeType: 'relay',
        signer: relayEast.keypair,
      });
      const westStake = await westClients.staking.depositStake({
        amountMist: 130_000_000_000n,
        stakeType: 'relay',
        signer: relayWest.keypair,
      });

      const eastRegistration = await eastClients.relayRegistry.registerRelay({
        endpoint: 'wss://relay-us-east.mesh.test/ws',
        stakeId: eastStake.stakeId,
        capabilities: ['routing', 'streaming'],
        region: 'us-east',
        routingFeeBps: 50,
        signer: relayEast.keypair,
      });
      const westRegistration = await westClients.relayRegistry.registerRelay({
        endpoint: 'wss://relay-eu-west.mesh.test/ws',
        stakeId: westStake.stakeId,
        capabilities: ['routing'],
        region: 'eu-west',
        routingFeeBps: 10,
        signer: relayWest.keypair,
      });

      const registeredRelay = await waitForCondition(async () => {
        const relay = await eastClients.relayRegistry.getRelay(eastRegistration.relayId);
        return relay?.status === RelayNodeStatus.ACTIVE ? relay : undefined;
      }, 20_000, 'Relay registration did not produce an active relay node.');

      expect(registeredRelay.endpoint).toBe('wss://relay-us-east.mesh.test/ws');
      expect(registeredRelay.stakePositionId).toBe(eastStake.stakeId);
      expect(registeredRelay.capabilities).toEqual(['routing', 'streaming']);
      expect(registeredRelay.stakeAmountMist).toBe(120_000_000_000n);

      const heartbeat = await eastClients.relayRegistry.heartbeat({
        relayId: eastRegistration.relayId,
        signer: relayEast.keypair,
      });
      const relayAfterHeartbeat = await waitForCondition(async () => {
        const relay = await eastClients.relayRegistry.getRelay(eastRegistration.relayId);
        return relay && relay.lastHeartbeat >= heartbeat.lastHeartbeat ? relay : undefined;
      }, 20_000, 'Relay heartbeat was not reflected on-chain.');

      await expect(
        eastClients.relayRegistry.recordRouting({
          relayId: eastRegistration.relayId,
          feeAmountMist: 25n,
          signer: relayEast.keypair,
        }),
      ).rejects.toThrow('Relay routing metrics are package-internal and cannot be reported by external operators.');
      const relayAfterHeartbeatRefresh = await eastClients.relayRegistry.getRelay(eastRegistration.relayId);

      const activeRelays = await eastClients.relayRegistry.listRelays();
      const eastRegionRelays = await eastClients.relayRegistry.listRelays({ region: 'us-east' });
      const streamingRelays = await eastClients.relayRegistry.listRelays({ capability: 'streaming' });
      const discovery = new RelayDiscovery(eastClients.relayRegistry, {
        cacheTtlMs: 100,
        heartbeatFreshnessMs: 60_000,
      });
      const bestEastRelay = await discovery.findBestRelay('routing', 'us-east');

      expect(relayAfterHeartbeat.lastHeartbeat).toBeGreaterThanOrEqual(registeredRelay.lastHeartbeat);
      expect(relayAfterHeartbeatRefresh?.totalRouted).toBe(0);
      expect(relayAfterHeartbeatRefresh?.totalFeesEarnedMist).toBe(0n);
      expect(new Set(activeRelays.map((relay) => relay.id))).toEqual(new Set([eastRegistration.relayId, westRegistration.relayId]));
      expect(eastRegionRelays.map((relay) => relay.id)).toEqual([eastRegistration.relayId]);
      expect(streamingRelays.map((relay) => relay.id)).toEqual([eastRegistration.relayId]);
      expect(bestEastRelay?.id).toBe(eastRegistration.relayId);

      await eastClients.relayRegistry.deactivateRelay({ relayId: eastRegistration.relayId, signer: relayEast.keypair });
      const inactiveRelay = await waitForCondition(async () => {
        const relay = await eastClients.relayRegistry.getRelay(eastRegistration.relayId);
        return relay?.status === RelayNodeStatus.INACTIVE ? relay : undefined;
      }, 20_000, 'Relay did not transition to inactive after deactivation.');
      const activeAfterDeactivation = await eastClients.relayRegistry.listRelays();
      const inactiveRelays = await eastClients.relayRegistry.listRelays({ activeOnly: false, status: RelayNodeStatus.INACTIVE });

      expect(inactiveRelay.status).toBe(RelayNodeStatus.INACTIVE);
      expect(activeAfterDeactivation.map((relay) => relay.id)).not.toContain(eastRegistration.relayId);
      expect(inactiveRelays.map((relay) => relay.id)).toContain(eastRegistration.relayId);
    },
    90_000,
  );
});
