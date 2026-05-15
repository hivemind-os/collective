import type { AgentCard, ReputationEvent, ReputationScore } from '@agentic-mesh/types';

interface CapabilityAccumulator {
  successes: number;
  failures: number;
  totalLatency: number;
  latencyCount: number;
}

export class ReputationScoreCalculator {
  computeScore(agentCard: AgentCard, events: ReputationEvent[]): ReputationScore {
    const relatedEvents = events.filter((event) => event.subject === agentCard.did);
    const eventSuccesses = relatedEvents.filter((event) => event.outcome === 'success').length;
    const eventFailures = relatedEvents.filter((event) => event.outcome === 'failure' || event.outcome === 'timeout' || event.outcome === 'cancelled').length;
    const eventDisputes = relatedEvents.filter((event) => event.type === 'dispute_opened' || event.outcome === 'disputed').length;
    const completed = Math.max(agentCard.totalTasksCompleted ?? 0, eventSuccesses);
    const failed = Math.max(agentCard.totalTasksFailed ?? 0, eventFailures);
    const disputed = Math.max(agentCard.totalTasksDisputed ?? 0, eventDisputes);
    const totalTasks = completed + failed;
    const successRate = totalTasks === 0 ? 0 : completed / totalTasks;
    const latencyEvents = relatedEvents.filter((event): event is ReputationEvent & { latencyMs: number } => typeof event.latencyMs === 'number');
    const averageLatencyMs = latencyEvents.length === 0
      ? 0
      : Math.round(latencyEvents.reduce((sum, event) => sum + event.latencyMs, 0) / latencyEvents.length);
    const totalEarningsMist = maxBigInt(
      agentCard.totalEarningsMist ?? 0n,
      relatedEvents.reduce((sum, event) => sum + paymentAmountToMist(event), 0n),
    );

    const capabilityAccumulators: Record<string, CapabilityAccumulator> = {};
    for (const event of relatedEvents) {
      const current = capabilityAccumulators[event.capability] ?? { successes: 0, failures: 0, totalLatency: 0, latencyCount: 0 };
      if (event.outcome === 'success') {
        current.successes += 1;
      }
      if (event.outcome === 'failure' || event.outcome === 'timeout' || event.outcome === 'cancelled') {
        current.failures += 1;
      }
      if (typeof event.latencyMs === 'number') {
        current.totalLatency += event.latencyMs;
        current.latencyCount += 1;
      }
      capabilityAccumulators[event.capability] = current;
    }

    const capabilityScores = Object.fromEntries(
      Object.entries(capabilityAccumulators).map(([capability, value]) => {
        const taskCount = value.successes + value.failures;
        return [
          capability,
          {
            successRate: taskCount === 0 ? 0 : value.successes / taskCount,
            taskCount,
            averageLatencyMs: value.latencyCount === 0 ? 0 : Math.round(value.totalLatency / value.latencyCount),
          },
        ];
      }),
    ) as ReputationScore['capabilityScores'];

    return {
      did: agentCard.did,
      successRate,
      totalTasks,
      totalDisputes: disputed,
      averageLatencyMs,
      totalEarningsMist,
      stakeAmount: agentCard.stakeMist ?? 0n,
      registeredAt: agentCard.registeredAt,
      lastActiveAt: Math.max(
        agentCard.updatedAt,
        ...relatedEvents.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
        0,
      ),
      capabilityScores,
    };
  }

  rankByReputation(agents: AgentCard[], scores: Map<string, ReputationScore>): AgentCard[] {
    return [...agents].sort((left, right) => compareScores(scores.get(right.did), scores.get(left.did)));
  }
}

function compareScores(left?: ReputationScore, right?: ReputationScore): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return (
    compareNumber(left.successRate, right.successRate) ||
    compareNumber(left.totalTasks, right.totalTasks) ||
    compareNumber(right.totalDisputes, left.totalDisputes) ||
    compareBigInt(left.stakeAmount, right.stakeAmount) ||
    compareBigInt(left.totalEarningsMist, right.totalEarningsMist) ||
    compareNumber(right.registeredAt, left.registeredAt)
  );
}

function paymentAmountToMist(event: ReputationEvent): bigint {
  if (!event.paymentAmount) {
    return 0n;
  }
  if (event.paymentAmount.currency.toUpperCase() !== 'MIST') {
    return 0n;
  }
  try {
    return BigInt(event.paymentAmount.amount);
  } catch {
    return 0n;
  }
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
