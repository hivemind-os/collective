import { sha256 } from '@noble/hashes/sha256';

import type { HashChainProof } from '@hivemind-os/collective-types';

const encoder = new TextEncoder();
const DEFAULT_SEED_PREFIX = 'agentic-mesh:metering:v1';
const HASH_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export const DEFAULT_METERING_CHUNK_SIZE = 1024;

export class HashChain {
  private currentHash: Uint8Array;
  private readonly intermediateHashes: string[] = [];

  constructor(private readonly seed: Uint8Array = encoder.encode(DEFAULT_SEED_PREFIX)) {
    this.currentHash = hashBytes(this.seed);
  }

  addUnit(data: Uint8Array): string {
    this.currentHash = hashBytes(concatBytes(this.currentHash, data));
    const hash = bytesToHex(this.currentHash);
    this.intermediateHashes.push(hash);
    return hash;
  }

  getRoot(): string {
    return bytesToHex(this.currentHash);
  }

  getProof(): HashChainProof {
    return {
      root: this.getRoot(),
      intermediateHashes: [...this.intermediateHashes],
      unitCount: this.intermediateHashes.length,
    };
  }

  static verifyChain(proof: HashChainProof, unitData: Uint8Array[], seed: Uint8Array = encoder.encode(DEFAULT_SEED_PREFIX)): boolean {
    if (
      proof.unitCount !== unitData.length
      || proof.intermediateHashes.length !== unitData.length
      || !HASH_HEX_PATTERN.test(proof.root)
      || proof.intermediateHashes.some((entry) => !HASH_HEX_PATTERN.test(entry))
    ) {
      return false;
    }

    let currentHash = hashBytes(seed);
    for (const [index, unit] of unitData.entries()) {
      currentHash = hashBytes(concatBytes(currentHash, unit));
      if (bytesToHex(currentHash) !== proof.intermediateHashes[index]) {
        return false;
      }
    }

    return bytesToHex(currentHash) === proof.root;
  }
}

export function createMeteringSeed(taskId: string): Uint8Array {
  return encoder.encode(`${DEFAULT_SEED_PREFIX}:${taskId}`);
}

export function splitIntoMeteringUnits(data: Uint8Array, chunkSize = DEFAULT_METERING_CHUNK_SIZE): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive safe integer.');
  }

  if (data.length === 0) {
    return [];
  }

  const units: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    units.push(data.slice(offset, Math.min(offset + chunkSize, data.length)));
  }

  return units;
}

function hashBytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}
