import pino from 'pino';

import type { AgentCard, Capability, NetworkConfig, ReputationScore } from '@hivemind-os/collective-types';
import type { Signer } from '@mysten/sui/cryptography';

import { parseAgentCardFields } from '../internal/parsing.js';
import { parseRawEvent } from '../events/parser.js';
import { ReputationScoreCalculator } from '../reputation/score-calculator.js';
import { MeshSuiClient } from '../sui/client.js';
import { StakingClient } from '../staking/client.js';
import {
  buildDeactivateAgentTx,
  buildReactivateAgentTx,
  buildRegisterAgentTx,
  buildSetEncryptionKeyTx,
  buildUpdateAgentTx,
  buildUpdateCapabilitiesTx,
} from '../sui/tx-helpers.js';

const logger = pino({ name: '@hivemind-os/collective-core:registry' });

export class RegistryClient {
  private readonly scoreCalculator = new ReputationScoreCalculator();
  private readonly stakingClient: StakingClient;

  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: NetworkConfig,
  ) {
    this.stakingClient = new StakingClient(suiClient, config);
  }

  async registerAgent(params: {
    name: string;
    did: string;
    description: string;
    capabilities: Capability[];
    endpoint: string;
    encryptionPublicKey?: Uint8Array;
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

    if (params.encryptionPublicKey !== undefined) {
      await this.setEncryptionKey({
        cardId: agentCardId,
        encryptionPublicKey: params.encryptionPublicKey,
        keypair: params.keypair,
      });
    }

    return { txDigest: response.digest, agentCardId };
  }

  async updateAgent(params: {
    cardId: string;
    name: string;
    description: string;
    endpoint: string;
    encryptionPublicKey?: Uint8Array;
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
    if (params.encryptionPublicKey !== undefined) {
      await this.setEncryptionKey({
        cardId: params.cardId,
        encryptionPublicKey: params.encryptionPublicKey,
        keypair: params.keypair,
      });
    }
    return { txDigest: response.digest };
  }

  async setEncryptionKey(params: {
    cardId: string;
    encryptionPublicKey: Uint8Array;
    keypair: Signer;
  }): Promise<{ txDigest: string }> {
    const tx = buildSetEncryptionKeyTx({
      packageId: this.config.packageId,
      cardId: params.cardId,
      encryptionPublicKey: params.encryptionPublicKey,
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
      return await this.enrichAgentStake(parseAgentCardFields(object, cardId));
    } catch (error) {
      if (isObjectMissingError(error)) {
        return null;
      }

      throw error;
    }
  }

  async getAgentCardByOwner(owner: string): Promise<AgentCard | null> {
    const page = await this.suiClient.client.getOwnedObjects({
      owner,
      filter: { StructType: `${this.config.packageId}::registry::AgentCard` },
      limit: 20,
    });

    const cards = await Promise.all(
      page.data
        .map((entry) => entry.data?.objectId)
        .filter((objectId): objectId is string => typeof objectId === 'string')
        .map(async (objectId) => await this.getAgentCard(objectId)),
    );

    return cards
      .filter((card): card is AgentCard => Boolean(card))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find((card) => card.active) ?? null;
  }

  async findAgentByDid(did: string): Promise<AgentCard | null> {
    const eventType = `${this.config.packageId}::registry::AgentRegistered`;
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, 100);
      for (const event of page.events) {
        const parsed = parseRawEvent(event, this.config.packageId);
        if (parsed?.type !== 'agent.registered' || parsed.agent.did !== did) {
          continue;
        }

        return await this.getAgentCard(parsed.agent.id);
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return null;
  }

  async discoverByCapability(
    capability: string,
    limit = 20,
    options: { sortByReputation?: boolean; scores?: Map<string, ReputationScore> } = {},
  ): Promise<AgentCard[]> {
    const eventType = `${this.config.packageId}::registry::AgentRegistered`;
    const matches: AgentCard[] = [];
    const seen = new Set<string>();
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
        if (current?.active && !seen.has(current.id)) {
          matches.push(current);
          seen.add(current.id);
        }

        if (!options.sortByReputation && matches.length >= limit) {
          return matches;
        }
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    if (!options.sortByReputation) {
      return [...matches].sort(compareStakePreference).slice(0, limit);
    }

    const scores = options.scores ?? new Map(matches.map((agent) => [agent.did, this.scoreCalculator.computeScore(agent, [])]));
    return this.scoreCalculator.rankByReputation(matches, scores).slice(0, limit);
  }

  private async enrichAgentStake(agent: AgentCard): Promise<AgentCard> {
    try {
      const stake = await this.stakingClient.getStakeByOwner(agent.owner);
      if (!stake) {
        return { ...agent, hasStake: false, stakeMist: undefined, stakeType: undefined };
      }

      return {
        ...agent,
        hasStake: Boolean(stake.isActive && stake.meetsMinium),
        stakeMist: stake.balanceMist,
        stakeType: stake.stakeType,
      };
    } catch {
      return { ...agent, hasStake: false, stakeMist: undefined, stakeType: undefined };
    }
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

function compareStakePreference(left: AgentCard, right: AgentCard): number {
  return (
    compareBoolean(left.hasStake ?? false, right.hasStake ?? false) ||
    compareBigInt(left.stakeMist ?? 0n, right.stakeMist ?? 0n) ||
    compareNumber(left.updatedAt, right.updatedAt)
  );
}

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) {
    return 0;
  }
  return left ? -1 : 1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}