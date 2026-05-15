import { describe, expect, it } from 'vitest';

import { PaymentRail, type AgentCard, type ReputationEvent } from '@agentic-mesh/types';

import { ReputationScoreCalculator } from '../../src/index.js';

function createAgent(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: '0xagent-1',
    owner: '0xowner',
    did: 'did:mesh:agent-1' as AgentCard['did'],
    name: 'Agent One',
    description: 'Helpful agent',
    capabilities: [
      {
        name: 'echo',
        description: 'Echo input',
        version: '1.0.0',
        pricing: {
          rail: PaymentRail.SUI_ESCROW,
          amount: 5n,
          currency: 'MIST',
        },
      },
    ],
    active: true,
    version: 1,
    registeredAt: 1_000,
    updatedAt: 2_000,
    totalTasksCompleted: 4,
    totalTasksFailed: 1,
    totalTasksDisputed: 1,
    totalEarningsMist: 50n,
    ...overrides,
  };
}

function createEvent(overrides: Partial<ReputationEvent> = {}): ReputationEvent {
  return {
    eventId: 'event-1',
    type: 'task_completion',
    subject: 'did:mesh:agent-1',
    author: 'did:mesh:requester',
    taskId: 'task-1',
    outcome: 'success',
    capability: 'echo',
    latencyMs: 100,
    paymentAmount: { amount: '25', currency: 'MIST' },
    timestamp: new Date(3_000).toISOString(),
    nonce: 'nonce-1',
    signature: 'signature-1',
    ...overrides,
  };
}

describe('ReputationScoreCalculator', () => {
  it('computes a score from on-chain counters and events', () => {
    const calculator = new ReputationScoreCalculator();
    const score = calculator.computeScore(createAgent(), [
      createEvent(),
      createEvent({ eventId: 'event-2', outcome: 'failure', type: 'task_failure', latencyMs: 300 }),
      createEvent({ eventId: 'event-3', type: 'dispute_opened', outcome: 'disputed', latencyMs: undefined }),
    ]);

    expect(score.successRate).toBeCloseTo(0.8);
    expect(score.totalTasks).toBe(5);
    expect(score.totalDisputes).toBe(1);
    expect(score.averageLatencyMs).toBe(200);
    expect(score.totalEarningsMist).toBe(75n);
    expect(score.stakeAmount).toBe(0n);
    expect(score.capabilityScores.echo?.taskCount).toBe(2);
  });

  it('ranks agents by reputation', () => {
    const calculator = new ReputationScoreCalculator();
    const stronger = createAgent();
    const weaker = createAgent({ id: '0xagent-2', did: 'did:mesh:agent-2' as AgentCard['did'], totalTasksCompleted: 1, totalTasksFailed: 2, totalEarningsMist: 1n });
    const scores = new Map([
      [stronger.did, calculator.computeScore(stronger, [])],
      [weaker.did, calculator.computeScore(weaker, [])],
    ]);

    expect(calculator.rankByReputation([weaker, stronger], scores).map((agent) => agent.did)).toEqual([
      stronger.did,
      weaker.did,
    ]);
  });

  it('uses stake as a reputation tiebreaker', () => {
    const calculator = new ReputationScoreCalculator();
    const staked = createAgent({ stakeMist: 10_000_000_000n, hasStake: true });
    const unstaked = createAgent({ id: '0xagent-2', did: 'did:mesh:agent-2' as AgentCard['did'] });
    const scores = new Map([
      [staked.did, calculator.computeScore(staked, [])],
      [unstaked.did, calculator.computeScore(unstaked, [])],
    ]);

    expect(calculator.rankByReputation([unstaked, staked], scores).map((agent) => agent.did)).toEqual([
      staked.did,
      unstaked.did,
    ]);
    expect(scores.get(staked.did)?.stakeAmount).toBe(10_000_000_000n);
  });
});
