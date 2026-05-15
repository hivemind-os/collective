import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SuiTestNetwork } from '../harness/index.js';
import {
  createNetworkConfig,
  createPhase3Clients,
  createArtifactRoot,
  removeDirectoryWithRetries,
  waitForCondition,
} from './test-helpers.js';

let artifactRoot: string;
let network: SuiTestNetwork;

describe('Phase 3 E2E: Staking lifecycle', () => {
  beforeAll(async () => {
    artifactRoot = await createArtifactRoot('phase3-staking');
    network = new SuiTestNetwork();
    await network.start();
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
    await removeDirectoryWithRetries(artifactRoot);
  }, 30_000);

  it(
    'deposits stake, rejects deposits below minimum, starts deactivation, and blocks early withdrawal',
    async () => {
      const wallet = await network.createFundedWallet(25_000_000_000n);
      const config = createNetworkConfig(network);
      const { staking } = createPhase3Clients(config);
      const amountMist = 10_000_000_000n;

      const deposited = await staking.depositStake({
        amountMist,
        stakeType: 'agent',
        signer: wallet.keypair,
      });

      const position = await waitForCondition(async () => {
        const current = await staking.getStakePosition(deposited.stakeId);
        return current?.balanceMist === amountMist ? current : undefined;
      }, 20_000, 'Stake position was not persisted on-chain');

      expect(position.owner).toBe(wallet.address);
      expect(position.stakeType).toBe('agent');
      expect(position.balanceMist).toBe(amountMist);
      expect(position.isActive).toBe(true);
      expect(position.meetsMinimum).toBe(true);

      await expect(
        staking.depositStake({
          amountMist: 9_999_999_999n,
          stakeType: 'agent',
          signer: wallet.keypair,
        }),
      ).rejects.toThrow();

      const deactivation = await staking.startDeactivation({
        stakeId: deposited.stakeId,
        signer: wallet.keypair,
      });

      const deactivated = await waitForCondition(async () => {
        const current = await staking.getStakePosition(deposited.stakeId);
        return current && current.deactivatedAt > 0 ? current : undefined;
      }, 20_000, 'Stake position never entered cooldown');

      expect(deactivation.cooldownEndsAt - deactivated.deactivatedAt).toBe(604_800_000);
      expect(deactivated.isActive).toBe(false);

      await expect(
        staking.withdrawStake({
          stakeId: deposited.stakeId,
          signer: wallet.keypair,
        }),
      ).rejects.toThrow();
    },
    60_000,
  );

  it.skip('slashes stake for non-delivery after task expiry once localnet clock fast-forward is available', async () => {
    // Local Sui E2E currently lacks a reliable way to fast-forward the shared clock by one hour
    // so an accepted task can expire on-chain before calling slash_non_delivery.
  });
});
