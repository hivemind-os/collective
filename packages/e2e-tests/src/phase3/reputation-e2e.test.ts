import type { AgentCard } from '@hivemind-os/collective-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  ReputationScoreCalculator,
  ReputationStore,
  TaskStatus,
  bytesToHex,
  ReputationAnchorClient,
  buildMerkleTree,
  completeTaskAndClaimWithCard,
  createAgentCard,
  createBlobStore,
  createPhase3Clients,
  createNetworkConfig,
  createReputationDbPath,
  createReputationEvent,
  createTestDid,
  createArtifactRoot,
  defaultPriceMist,
  postTaskWithBlobStore,
  registerTestAgent,
  removeDirectoryWithRetries,
  verifyMerkleProof,
  waitForCondition,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 3 E2E: Reputation', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-reputation');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'updates on-chain AgentCard counters and anchors local reputation events with a verified Merkle root',
    async () => {
      const requester = await network.createFundedWallet();
      const provider = await network.createFundedWallet();
      const config = createNetworkConfig(network);
      const requesterClients = createPhase3Clients(config);
      const requesterTaskClient = requesterClients.task;
      const { clients: providerClients, agentCardId, did } = await registerTestAgent({
        config,
        wallet: provider,
        capabilityName: 'reputation-echo',
        name: 'Reputation Provider',
      });
      const blobStore = await createBlobStore(artifactRoot, 'reputation-blobs');
      const priceMist = 250_000_000n;

      const posted = await postTaskWithBlobStore({
        taskClient: requesterTaskClient,
        blobStore,
        input: 'reputation payload',
        capability: 'reputation-echo',
        priceMist,
        disputeWindowMs: 0,
        keypair: requester.keypair,
      });

      await completeTaskAndClaimWithCard({
        requesterTaskClient,
        providerTaskClient: providerClients.task,
        blobStore,
        taskId: posted.taskId,
        inputData: posted.inputData,
        capability: 'reputation-echo',
        providerCardId: agentCardId,
        providerKeypair: provider.keypair,
      });

      const releasedTask = await waitForCondition(async () => {
        const task = await requesterTaskClient.getTask(posted.taskId);
        return task?.status === TaskStatus.RELEASED ? task : undefined;
      }, 20_000, 'Task was not released after provider claim');
      expect(releasedTask.price).toBe(priceMist);

      const providerCard = await waitForCondition(async () => {
        const card = await providerClients.registry.getAgentCard(agentCardId);
        return card?.totalTasksCompleted === 1 && card.totalEarningsMist === priceMist ? card : undefined;
      }, 20_000, 'Provider card counters were not updated');

      expect(providerCard.totalTasksCompleted).toBe(1);
      expect(providerCard.totalEarningsMist).toBe(priceMist);

      const store = new ReputationStore(await createReputationDbPath(artifactRoot, 'provider'));
      try {
        const events = [
          createReputationEvent({
            subject: did,
            taskId: posted.taskId,
            capability: 'reputation-echo',
            paymentAmount: { amount: priceMist.toString(), currency: 'MIST' },
            latencyMs: 180,
          }),
          createReputationEvent({
            subject: did,
            taskId: `${posted.taskId}-failure`,
            type: 'task_failure',
            outcome: 'failure',
            paymentAmount: undefined,
            latencyMs: 420,
          }),
          createReputationEvent({
            subject: did,
            taskId: `${posted.taskId}-dispute`,
            type: 'dispute_opened',
            outcome: 'disputed',
            paymentAmount: undefined,
            latencyMs: undefined,
          }),
        ];

        for (const event of events) {
          await store.addEvent(event);
        }

        const stats = await store.getStats(did);
        expect(stats).toEqual({ completed: 1, failed: 1, disputed: 1 });

        const unanchored = await store.getUnanchoredEvents();
        const tree = buildMerkleTree(unanchored);
        const rootHex = bytesToHex(tree.root);

        expect(rootHex).toHaveLength(64);
        expect(verifyMerkleProof(unanchored[1]!, tree.proof(1), tree.root, 1)).toBe(true);

        const anchorClient = new ReputationAnchorClient(providerClients.sui, config);
        const published = await anchorClient.publishAnchor(unanchored, blobStore, provider.keypair);
        await store.markAnchored(unanchored.map((event) => event.eventId), published.anchorId);

        expect(published.merkleRoot).toBe(rootHex);
        expect(await store.getUnanchoredEvents()).toEqual([]);

        const anchors = await anchorClient.getAnchors(provider.address, 10);
        expect(anchors.find((anchor) => anchor.anchorId === published.anchorId)).toMatchObject({
          author: provider.address,
          eventCount: 3,
          merkleRoot: rootHex,
        });

        const score = new ReputationScoreCalculator().computeScore(providerCard, unanchored);
        expect(score.did).toBe(did);
        expect(score.totalTasks).toBe(2);
        expect(score.totalDisputes).toBe(1);
        expect(score.successRate).toBeCloseTo(0.5);
        expect(score.totalEarningsMist).toBe(priceMist);
      } finally {
        store.close();
      }
    },
    60_000,
  );

  it(
    'ranks agents with different reputation histories by relative score',
    async () => {
      const strongerDid = createTestDid('stronger') as ReturnType<typeof createTestDid>;
      const weakerDid = createTestDid('weaker') as ReturnType<typeof createTestDid>;
      const stronger = createAgentCard({
        did: strongerDid as AgentCard['did'],
        totalTasksCompleted: 5,
        totalTasksFailed: 0,
        totalTasksDisputed: 0,
        totalEarningsMist: defaultPriceMist * 3n,
        stakeMist: 10_000_000_000n,
        hasStake: true,
      });
      const weaker = createAgentCard({
        did: weakerDid as AgentCard['did'],
        totalTasksCompleted: 1,
        totalTasksFailed: 2,
        totalTasksDisputed: 1,
        totalEarningsMist: 1n,
      });
      const calculator = new ReputationScoreCalculator();
      const strongerEvents = [
        createReputationEvent({ subject: strongerDid, paymentAmount: { amount: defaultPriceMist.toString(), currency: 'MIST' } }),
        createReputationEvent({ subject: strongerDid, taskId: 'strong-2' }),
      ];
      const weakerEvents = [
        createReputationEvent({ subject: weakerDid, type: 'task_failure', outcome: 'failure', paymentAmount: undefined }),
        createReputationEvent({ subject: weakerDid, type: 'dispute_opened', outcome: 'disputed', paymentAmount: undefined }),
      ];

      const scores = new Map([
        [stronger.did, calculator.computeScore(stronger, strongerEvents)],
        [weaker.did, calculator.computeScore(weaker, weakerEvents)],
      ]);
      const ranked = calculator.rankByReputation([weaker, stronger], scores);

      expect(scores.get(stronger.did)?.successRate).toBeGreaterThan(scores.get(weaker.did)?.successRate ?? 0);
      expect(scores.get(stronger.did)?.stakeAmount).toBe(10_000_000_000n);
      expect(ranked.map((agent) => agent.did)).toEqual([stronger.did, weaker.did]);
    },
    30_000,
  );
});
