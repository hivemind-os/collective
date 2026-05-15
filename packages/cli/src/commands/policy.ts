import { PaymentRail } from '@agentic-mesh/types';

import { loadMeshConfig, saveMeshConfig } from './config.js';
import { parseSuiToMist } from './wallet.js';
import { success } from '../utils/output.js';

export async function handlePolicy(subcommand?: string, args: string[] = []): Promise<number> {
  if (subcommand !== 'set') {
    throw new Error('Usage: mesh policy set [--daily <amount_sui>] [--per-task <amount_sui>]');
  }

  const daily = readFlag(args, '--daily');
  const perTask = readFlag(args, '--per-task');
  if (!daily && !perTask) {
    throw new Error('Provide at least one policy flag: --daily or --per-task');
  }

  const config = loadMeshConfig();
  if (daily) {
    upsertLimit(config, 'day', parseSuiToMist(daily));
  }
  if (perTask) {
    upsertLimit(config, 'transaction', parseSuiToMist(perTask));
  }
  saveMeshConfig(config);

  success('Updated spending policy.');
  return 0;
}

function upsertLimit(config: ReturnType<typeof loadMeshConfig>, interval: 'day' | 'transaction', amount: bigint): void {
  const existing = config.spending.limits.find((limit) => limit.interval === interval);
  if (existing) {
    existing.amount = amount;
    existing.rail = PaymentRail.SUI_ESCROW;
    return;
  }

  config.spending.limits.push({
    amount,
    interval,
    rail: PaymentRail.SUI_ESCROW,
  });
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
