import { MeshSuiClient, RegistryClient } from '@agentic-mesh/core';
import type { AgentCard } from '@agentic-mesh/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import { createCapability, createNetworkConfig, createTestDid, waitForCondition } from './test-helpers.js';

const testTimeoutMs = 60_000;
const discoveryTimeoutMs = 20_000;

let network: SuiTestNetwork;

describe('Phase 1 E2E: Registry operations', () => {
  beforeAll(async () => {
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
  }, 30_000);

  it(
    'registers an agent with capabilities and persists the on-chain AgentCard',
    async () => {
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const registryClient = new RegistryClient(new MeshSuiClient(config), config);
      const capability = createCapability({
        name: `echo-${Date.now()}`,
        description: 'Echoes payloads back to the caller',
        version: '1.2.3',
        amountMist: 222_000_000n,
      });

      const registration = await registryClient.registerAgent({
        name: 'Registry E2E Provider',
        did: createTestDid('registry'),
        description: 'Provider used for registry e2e coverage',
        capabilities: [capability],
        endpoint: 'mesh://provider/registry-e2e',
        keypair: provider.keypair,
      });

      const agentCard = await registryClient.getAgentCard(registration.agentCardId);
      expect(agentCard).toMatchObject({
        id: registration.agentCardId,
        owner: provider.address,
        name: 'Registry E2E Provider',
        description: 'Provider used for registry e2e coverage',
        endpoint: 'mesh://provider/registry-e2e',
        active: true,
      });
      expect(agentCard?.capabilities).toEqual([capability]);
      expect(agentCard?.version).toBe(1);
    },
    testTimeoutMs,
  );

  it(
    'updates agent capabilities by adding and removing entries',
    async () => {
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const registryClient = new RegistryClient(new MeshSuiClient(config), config);
      const original = createCapability({ name: `echo-${Date.now()}` });
      const added = createCapability({
        name: `summarize-${Date.now()}`,
        description: 'Summarizes input text',
        version: '2.0.0',
        amountMist: 333_000_000n,
      });

      const registration = await registryClient.registerAgent({
        name: 'Capability Updater',
        did: createTestDid('capability-update'),
        description: 'Starts with one capability and updates to another set',
        capabilities: [original],
        endpoint: 'mesh://provider/capability-update',
        keypair: provider.keypair,
      });
      const beforeUpdate = await registryClient.getAgentCard(registration.agentCardId);

      await registryClient.updateCapabilities({
        cardId: registration.agentCardId,
        capabilities: [added],
        keypair: provider.keypair,
      });

      const updatedCard = await waitForCondition(async () => {
        const card = await registryClient.getAgentCard(registration.agentCardId);
        return card?.version === 2 ? card : undefined;
      }, discoveryTimeoutMs, 'Updated AgentCard was not observed');

      expect(beforeUpdate?.capabilities).toEqual([original]);
      expect(updatedCard.capabilities).toEqual([added]);
      expect(updatedCard.capabilities.map((capability) => capability.name)).not.toContain(original.name);
    },
    testTimeoutMs,
  );

  it(
    'deactivates an agent and removes it from discovery',
    async () => {
      await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const providerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const capability = createCapability({ name: `deactivate-${Date.now()}` });

      const registration = await providerRegistry.registerAgent({
        name: 'Deactivate Me',
        did: createTestDid('deactivate'),
        description: 'Will be deactivated during the test',
        capabilities: [capability],
        endpoint: 'mesh://provider/deactivate',
        keypair: provider.keypair,
      });

      await providerRegistry.deactivateAgent({
        cardId: registration.agentCardId,
        keypair: provider.keypair,
      });

      const deactivatedCard = await waitForCondition(async () => {
        const card = await providerRegistry.getAgentCard(registration.agentCardId);
        return card?.active === false ? card : undefined;
      }, discoveryTimeoutMs, 'AgentCard never became inactive');

      expect(deactivatedCard.active).toBe(false);
      await waitForCondition(async () => {
        const agents = await consumerRegistry.discoverByCapability(capability.name, 20);
        return agents.every((agent) => agent.id !== registration.agentCardId) ? agents : undefined;
      }, discoveryTimeoutMs, 'Deactivated agent remained discoverable');
    },
    testTimeoutMs,
  );

  it(
    're-activates an agent and makes it discoverable again',
    async () => {
      await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const providerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const capability = createCapability({ name: `reactivate-${Date.now()}` });

      const registration = await providerRegistry.registerAgent({
        name: 'Reactivate Me',
        did: createTestDid('reactivate'),
        description: 'Cycles between active and inactive',
        capabilities: [capability],
        endpoint: 'mesh://provider/reactivate',
        keypair: provider.keypair,
      });
      await providerRegistry.deactivateAgent({ cardId: registration.agentCardId, keypair: provider.keypair });

      await providerRegistry.reactivateAgent({
        cardId: registration.agentCardId,
        keypair: provider.keypair,
      });

      const reactivatedCard = await waitForCondition(async () => {
        const card = await providerRegistry.getAgentCard(registration.agentCardId);
        return card?.active === true && card.version >= 2 ? card : undefined;
      }, discoveryTimeoutMs, 'AgentCard never reactivated');
      const discovered = await waitForCondition(
        async () => {
          const agents = await consumerRegistry.discoverByCapability(capability.name, 20);
          return agents.find((agent) => agent.id === registration.agentCardId);
        },
        discoveryTimeoutMs,
        'Reactivated agent was not rediscovered',
      );

      expect(reactivatedCard.active).toBe(true);
      expect(discovered.id).toBe(registration.agentCardId);
    },
    testTimeoutMs,
  );

  it(
    'registers multiple agents concurrently',
    async () => {
      await network.createFundedWallet();
      const providers = await Promise.all([
        network.createFundedWallet(),
        network.createFundedWallet(),
        network.createFundedWallet(),
      ]);
      const config = createNetworkConfig(network);
      const consumerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const capabilityName = `concurrent-${Date.now()}`;

      const registrations = await Promise.all(
        providers.map((provider, index) => {
          const registryClient = new RegistryClient(new MeshSuiClient(config), config);
          return registryClient.registerAgent({
            name: `Concurrent Provider ${index + 1}`,
            did: createTestDid(`concurrent-${index}`),
            description: `Concurrent provider ${index + 1}`,
            capabilities: [createCapability({ name: capabilityName, version: `1.0.${index}` })],
            endpoint: `mesh://provider/concurrent-${index + 1}`,
            keypair: provider.keypair,
          });
        }),
      );

      const discovered = await waitForCondition(
        async () => {
          const agents = await consumerRegistry.discoverByCapability(capabilityName, 20);
          const matchingIds = new Set(agents.map((agent) => agent.id));
          return registrations.every((registration) => matchingIds.has(registration.agentCardId)) ? agents : undefined;
        },
        discoveryTimeoutMs,
        'Concurrent registrations were not all discoverable',
      );

      expect(discovered.filter((agent) => registrations.some((registration) => registration.agentCardId === agent.id))).toHaveLength(
        registrations.length,
      );
    },
    testTimeoutMs,
  );

  it(
    'discovers agents by capability name',
    async () => {
      await network.createFundedWallet();
      const echoProvider = await network.createFundedWallet();
      const otherProvider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const echoRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const otherRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const targetCapability = `discover-${Date.now()}`;

      const matching = await echoRegistry.registerAgent({
        name: 'Discoverable Provider',
        did: createTestDid('discover-match'),
        description: 'Has the desired capability',
        capabilities: [createCapability({ name: targetCapability })],
        endpoint: 'mesh://provider/discoverable',
        keypair: echoProvider.keypair,
      });
      await otherRegistry.registerAgent({
        name: 'Non-matching Provider',
        did: createTestDid('discover-other'),
        description: 'Does not have the desired capability',
        capabilities: [createCapability({ name: `other-${Date.now()}` })],
        endpoint: 'mesh://provider/non-matching',
        keypair: otherProvider.keypair,
      });

      const discovered = await waitForCondition(
        async () => {
          const agents = await consumerRegistry.discoverByCapability(targetCapability, 20);
          return agents.find((agent) => agent.id === matching.agentCardId) ? agents : undefined;
        },
        discoveryTimeoutMs,
        'Capability search did not find the expected provider',
      );

      expect(discovered.map((agent) => agent.id)).toContain(matching.agentCardId);
      expect(discovered.every((agent) => agent.capabilities.some((capability) => capability.name === targetCapability))).toBe(true);
    },
    testTimeoutMs,
  );

  it(
    'returns the correct capability metadata when discovering agents',
    async () => {
      await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const consumerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const providerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const capability = createCapability({
        name: `metadata-${Date.now()}`,
        description: 'Produces rich metadata for discovery assertions',
        version: '9.9.9',
        amountMist: 987_654_321n,
      });

      const registration = await providerRegistry.registerAgent({
        name: 'Metadata Provider',
        did: createTestDid('metadata'),
        description: 'Publishes precise capability metadata',
        capabilities: [capability],
        endpoint: 'mesh://provider/metadata',
        keypair: provider.keypair,
      });

      const discovered = await waitForCondition(
        async () => {
          const agents = await consumerRegistry.discoverByCapability(capability.name, 20);
          return agents.find((agent) => agent.id === registration.agentCardId);
        },
        discoveryTimeoutMs,
        'Discoverability metadata never appeared',
      );

      expect(discovered.capabilities).toEqual([capability]);
    },
    testTimeoutMs,
  );

  it('returns null when querying a non-existent agent', async () => {
    const config = createNetworkConfig(network);
    const registryClient = new RegistryClient(new MeshSuiClient(config), config);

    await expect(registryClient.getAgentCard('0x999999')).resolves.toBeNull();
  });

  it(
    "does not allow someone else to deactivate another agent's card",
    async () => {
      const provider = await network.createFundedWallet();
      const attacker = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const providerRegistry = new RegistryClient(new MeshSuiClient(config), config);
      const attackerRegistry = new RegistryClient(new MeshSuiClient(config), config);

      const registration = await providerRegistry.registerAgent({
        name: 'Protected Provider',
        did: createTestDid('protected'),
        description: 'Only the owner should be able to deactivate this card',
        capabilities: [createCapability({ name: `protected-${Date.now()}` })],
        endpoint: 'mesh://provider/protected',
        keypair: provider.keypair,
      });

      await expect(
        attackerRegistry.deactivateAgent({
          cardId: registration.agentCardId,
          keypair: attacker.keypair,
        }),
      ).rejects.toThrow();

      const card = await providerRegistry.getAgentCard(registration.agentCardId);
      expect(card?.active).toBe(true);
    },
    testTimeoutMs,
  );

  it(
    'registers an agent with an empty capability list',
    async () => {
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const registryClient = new RegistryClient(new MeshSuiClient(config), config);

      const registration = await registryClient.registerAgent({
        name: 'Capability-less Provider',
        did: createTestDid('empty-capabilities'),
        description: 'Publishes no capabilities',
        capabilities: [],
        endpoint: 'mesh://provider/empty-capabilities',
        keypair: provider.keypair,
      });

      const card = await registryClient.getAgentCard(registration.agentCardId);
      expect(card?.capabilities).toEqual([]);
    },
    testTimeoutMs,
  );

  it(
    'registers an agent with multiple capabilities',
    async () => {
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const registryClient = new RegistryClient(new MeshSuiClient(config), config);
      const capabilities = [
        createCapability({ name: `echo-${Date.now()}` }),
        createCapability({ name: `summarize-${Date.now()}`, description: 'Summarizes content', amountMist: 50_000_000n }),
        createCapability({ name: `translate-${Date.now()}`, description: 'Translates content', version: '3.1.4' }),
      ];

      const registration = await registryClient.registerAgent({
        name: 'Multi-capability Provider',
        did: createTestDid('multi-capability'),
        description: 'Publishes several capabilities at once',
        capabilities,
        endpoint: 'mesh://provider/multi-capability',
        keypair: provider.keypair,
      });

      const card = (await registryClient.getAgentCard(registration.agentCardId)) as AgentCard;
      expect(card.capabilities).toEqual(capabilities);
      expect(card.capabilities).toHaveLength(3);
    },
    testTimeoutMs,
  );
});
