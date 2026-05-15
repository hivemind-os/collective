import { describe, expect, it } from 'vitest';

import type { ReputationEvent } from '@agentic-mesh/types';

import { buildMerkleTree, verifyMerkleProof } from '../../src/index.js';

function createEvent(index: number): ReputationEvent {
  return {
    eventId: `event-${index}`,
    type: 'task_completion',
    subject: 'did:mesh:provider',
    author: 'did:mesh:requester',
    taskId: `task-${index}`,
    outcome: 'success',
    capability: 'echo',
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    nonce: `nonce-${index}`,
    signature: `signature-${index}`,
  };
}

describe('Merkle tree', () => {
  it('builds proofs for multiple leaves', () => {
    const events = [createEvent(1), createEvent(2), createEvent(3), createEvent(4)];
    const tree = buildMerkleTree(events);

    expect(verifyMerkleProof(events[2]!, tree.proof(2), tree.root, 2)).toBe(true);
  });

  it('supports odd numbers of leaves', () => {
    const events = [createEvent(1), createEvent(2), createEvent(3)];
    const tree = buildMerkleTree(events);

    expect(verifyMerkleProof(events[2]!, tree.proof(2), tree.root, 2)).toBe(true);
  });

  it('supports a single leaf', () => {
    const events = [createEvent(1)];
    const tree = buildMerkleTree(events);

    expect(tree.proof(0)).toEqual([]);
    expect(verifyMerkleProof(events[0]!, tree.proof(0), tree.root, 0)).toBe(true);
  });
});
