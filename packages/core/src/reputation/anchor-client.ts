import type { ReputationAnchor, ReputationEvent } from '@hivemind-os/collective-types';
import type { Signer } from '@mysten/sui/cryptography';

import type { BlobStore } from '../blobstore/interface.js';
import { bytesToHex, bytesToString } from '../internal/parsing.js';
import { MeshSuiClient } from '../sui/client.js';
import { buildPublishReputationAnchorTx } from '../sui/tx-helpers.js';

import { buildMerkleTree } from './merkle.js';

export interface ContractConfig {
  packageId: string;
}

export class ReputationAnchorClient {
  constructor(
    private readonly suiClient: MeshSuiClient,
    private readonly config: ContractConfig,
  ) {}

  async publishAnchor(
    events: ReputationEvent[],
    blobStore: BlobStore,
    signer: Signer,
  ): Promise<{ anchorId: string; merkleRoot: string; txDigest: string }> {
    if (events.length === 0) {
      throw new Error('At least one reputation event is required to publish an anchor.');
    }

    const { root } = buildMerkleTree(events);
    const stored = await blobStore.store(new TextEncoder().encode(JSON.stringify(events)));
    const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
    const tx = buildPublishReputationAnchorTx({
      packageId: this.config.packageId,
      merkleRoot: [...root],
      eventCount: events.length,
      blobId: stored.blobId,
      fromTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      toTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    });
    const response = await this.suiClient.executeTransaction(tx, signer);
    const anchorId = extractObjectId(response.objectChanges, /::reputation::ReputationAnchor$/);
    if (!anchorId) {
      throw new Error('Unable to determine reputation anchor id from transaction response.');
    }

    return {
      anchorId,
      merkleRoot: Buffer.from(root).toString('hex'),
      txDigest: response.digest,
    };
  }

  async getAnchors(author?: string, limit = 20): Promise<ReputationAnchor[]> {
    const eventType = `${this.config.packageId}::reputation::AnchorPublished`;
    const anchors: ReputationAnchor[] = [];
    let cursor = null;

    do {
      const page = await this.suiClient.queryEvents(eventType, cursor, Math.max(limit * 2, 20));
      const candidates = page.events.filter((event) => {
        const payload = event.parsedJson as { author?: string } | null | undefined;
        return !author || payload?.author === author;
      });
      const fetched = await Promise.all(candidates.map((event) => this.fetchAnchor(asString((event.parsedJson as { anchor_id?: string })?.anchor_id))));
      anchors.push(...fetched.filter((anchor): anchor is ReputationAnchor => Boolean(anchor)));
      if (anchors.length >= limit) {
        return anchors.slice(0, limit);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return anchors.slice(0, limit);
  }

  private async fetchAnchor(anchorId: string): Promise<ReputationAnchor | null> {
    if (!anchorId) {
      return null;
    }

    try {
      const object = await this.suiClient.getObject<Record<string, unknown>>(anchorId);
      return {
        anchorId,
        author: asString(object.author),
        merkleRoot: bytesToHex(asBytes(object.merkle_root)),
        eventCount: Number(object.event_count ?? 0),
        blobId: bytesToString(object.blob_id),
        fromTimestamp: Number(object.from_timestamp ?? 0),
        toTimestamp: Number(object.to_timestamp ?? 0),
      };
    } catch {
      return null;
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return new Uint8Array(value);
  }
  return new Uint8Array();
}
