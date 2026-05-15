import { createHash } from 'node:crypto';

import type { ReputationEvent } from '@agentic-mesh/types';

import { serializeReputationEvent } from './serialization.js';

export function buildMerkleTree(events: ReputationEvent[]): {
  root: Uint8Array;
  proof: (index: number) => Uint8Array[];
} {
  if (events.length === 0) {
    throw new Error('Cannot build a Merkle tree from an empty event set.');
  }

  const leaves = events.map((event) => hash(serializeReputationEvent(event)));
  const levels: Uint8Array[][] = [leaves];

  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]!;
      const right = current[index + 1] ?? left;
      next.push(hash(concat(left, right)));
    }
    levels.push(next);
  }

  return {
    root: levels[levels.length - 1]![0]!,
    proof: (index: number) => createProof(levels, index),
  };
}

export function verifyMerkleProof(
  event: ReputationEvent,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
): boolean {
  let computed = hash(serializeReputationEvent(event));
  let offset = index;

  for (const sibling of proof) {
    computed = offset % 2 === 0 ? hash(concat(computed, sibling)) : hash(concat(sibling, computed));
    offset = Math.floor(offset / 2);
  }

  return Buffer.from(computed).equals(Buffer.from(root));
}

function createProof(levels: Uint8Array[][], index: number): Uint8Array[] {
  const leaves = levels[0] ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`Merkle proof index ${index} is out of range.`);
  }

  const proof: Uint8Array[] = [];
  let offset = index;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level]!;
    const siblingIndex = offset % 2 === 0 ? offset + 1 : offset - 1;
    proof.push(nodes[siblingIndex] ?? nodes[offset]!);
    offset = Math.floor(offset / 2);
  }

  return proof;
}

function hash(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}
