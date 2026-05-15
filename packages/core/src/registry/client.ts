import pino from 'pino';

import type { AgentCard, Capability, NetworkConfig } from '@agentic-mesh/types';
import type { Signer } from '@mysten/sui/cryptography';

import { parseAgentCardFields } from '../internal/parsing.js';
import { parseRawEvent } from '../events/parser.js';
import { MeshSuiClient } from '../sui/client.js';
import {
  buildDeactivateAgentTx,
  buildReactivateAgentTx,
  buildRegisterAgentTx,
  buildUpdateAgentTx,
  buildUpdateCapabilitiesTx,
} from '../sui/tx-helpers.js';

const logger = pino({ name: '@agentic-mesh/core:registry' });

export class RegistryClient {
  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: NetworkConfig,
  ) {}

  async registerAgent(params: {
    name: string;
    did: string;
    description: string;
    capabilities: Capability[];
    endpoint: string;
    keypair: Signer;
  }): Promise<{ txDigest: string; agentCardId: string }> {
    const tx = buildRegisterAgentTx({
      packageId: this.config.packageId,
      registryId: this.config.registryId,
      name: params.name,
      did: params.did,
      description: params.description,
      capabilities: params.capabilities,
      endpoint: params.endpoint,
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    const agentCardId = extractObjectId(response.objectChanges, /::registry::AgentCard$/);

    if (!agentCardId) {
      logger.warn({ response }, 'Agent registration succeeded without an AgentCard object change.');
      throw new Error('Unable to determine AgentCard object id from transaction response.');
    }

    return { txDigest: response.digest, agentCardId };
  }

  async updateAgent(params: {
    cardId: string;
    name: string;
    description: string;
    endpoint: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildUpdateAgentTx({
      packageId: this.config.packageId,
      registryId: this.config.registryId,
      cardId: params.cardId,
      name: params.name,
      description: params.description,
      endpoint: params.endpoint,
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async updateCapabilities(params: {
    cardId: string;
    capabilities: Capability[];
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildUpdateCapabilitiesTx({
      packageId: this.config.packageId,
      registryId: this.config.registryId,
      cardId: params.cardId,
      capabilities: params.capabilities,
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async deactivateAgent(params: {
    cardId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildDeactivateAgentTx({
      packageId: this.config.packageId,
      registryId: this.config.registryId,
      cardId: params.cardId,
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async reactivateAgent(params: {
    cardId: string;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildReactivateAgentTx({
      packageId: this.config.packageId,
      registryId: this.config.registryId,
      cardId: params.cardId,
    });

    const response = await this.suiClient.executeTransaction(tx, params.keypair);
    return { txDigest: response.digest };
  }

  async getAgentCard(cardId: string): Promise<AgentCard | null> {
    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(cardId);
      return parseAgentCardFields(object, cardId);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }

      throw error;
    }
  }

  async discoverByCapability(capability: string, limit = 20): Promise<AgentCard[]> {
    const eventType = `${this.config.packageId}::registry::AgentRegistered`;
    const matches: AgentCard[] = [];
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, Math.max(limit * 2, 20));
      for (const event of page.events) {
        const parsed = parseRawEvent(event, this.config.packageId);
        if (parsed?.type !== 'agent.registered') {
          continue;
        }

        const hasMatch = parsed.agent.capabilities.some(
          (entry) => entry.name.toLowerCase() === capability.toLowerCase(),
        );
        if (!hasMatch) {
          continue;
        }

        const current = await this.getAgentCard(parsed.agent.id);
        if (current?.active) {
          matches.push(current);
        }

        if (matches.length >= limit) {
          return matches;
        }
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return matches;
  }
}

function extractObjectId(
  objectChanges: Array<Record<string, unknown>> | null | undefined,
  objectTypePattern: RegExp,
): string | undefined {
  return objectChanges?.find(
    (change) =>
      (change.type === 'created' || change.type === 'transferred' || change.type === 'mutated') &&
      typeof change.objectType === 'string' &&
      objectTypePattern.test(change.objectType) &&
      typeof change.objectId === 'string',
  )?.objectId as string | undefined;
}

function isObjectMissingError(error: unknown): boolean {
  return error instanceof Error && /not found|does not contain move object data/i.test(error.message);
}
