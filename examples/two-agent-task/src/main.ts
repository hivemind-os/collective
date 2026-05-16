import { FilesystemBlobStore } from '@agentic-mesh/core';

import { ECHO_PRICE_MIST, registerProvider, startListening, type ProviderListenerHandle } from './agent-a.js';
import { discoverAndExecute } from './agent-b.js';
import { LocalSuiDemo, delay, formatMistAsSui } from './setup.js';

const color = {
  blue: (value: string) => `\u001b[34m${value}\u001b[0m`,
  cyan: (value: string) => `\u001b[36m${value}\u001b[0m`,
  green: (value: string) => `\u001b[32m${value}\u001b[0m`,
  magenta: (value: string) => `\u001b[35m${value}\u001b[0m`,
  red: (value: string) => `\u001b[31m${value}\u001b[0m`,
  yellow: (value: string) => `\u001b[33m${value}\u001b[0m`,
};

const divider = color.blue('='.repeat(72));

async function run(): Promise<void> {
  const demo = new LocalSuiDemo();
  const blobStore = new FilesystemBlobStore(demo.blobStoreDir);
  let providerListener: ProviderListenerHandle | undefined;
  let shuttingDown = false;

  const cleanup = async (exitCode: number, error?: unknown): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log();
    console.log(stepLabel(8, '🧹', 'Cleaning up...'));

    await providerListener?.stop().catch(() => undefined);
    await demo.stop().catch(() => undefined);

    if (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(color.red(message));
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    console.log();
    console.log(color.yellow('Received Ctrl+C. Shutting down the local network gracefully...'));
    void cleanup(130);
  });

  try {
    printBanner();

    console.log(stepLabel(1, '🚀', 'Starting local Sui test network...'));
    await demo.start();
    console.log(`    RPC: ${demo.networkConfig.rpcUrl}`);
    console.log(`    Faucet: ${demo.networkConfig.faucetUrl}`);
    console.log(`    Package: ${demo.networkConfig.packageId}`);
    console.log(`    Registry: ${demo.networkConfig.registryId}`);

    console.log();
    console.log(stepLabel(2, '💰', 'Creating funded wallets...'));
    const agentA = await demo.createFundedWallet('Agent A');
    const agentB = await demo.createFundedWallet('Agent B');
    console.log(`    Agent A (provider): ${agentA.address}`);
    console.log(`    Agent B (requester): ${agentB.address}`);

    console.log();
    console.log(stepLabel(3, '📊', 'Showing starting balances...'));
    const startingBalances = {
      agentA: await demo.getBalance(agentA.address),
      agentB: await demo.getBalance(agentB.address),
    };
    printBalanceLine('Agent A start', startingBalances.agentA);
    printBalanceLine('Agent B start', startingBalances.agentB);

    console.log();
    console.log(stepLabel(4, '🪪', 'Registering Agent A and starting its listener...'));
    const registration = await registerProvider({
      networkConfig: demo.networkConfig,
      keypair: agentA.keypair,
      blobStore,
      cursorDbPath: demo.providerCursorDbPath,
      log: (message) => console.log(`    ${message}`),
    });
    providerListener = await startListening({
      networkConfig: demo.networkConfig,
      keypair: agentA.keypair,
      blobStore,
      cursorDbPath: demo.providerCursorDbPath,
      log: (message) => console.log(`    ${message}`),
    });
    console.log(`    Capability: echo @ ${formatMistAsSui(ECHO_PRICE_MIST)} SUI`);
    console.log(`    Agent card: ${registration.agentCardId}`);

    console.log();
    console.log(stepLabel(5, '⏳', 'Waiting for registration to propagate...'));
    await delay(1_500);
    console.log('    Agent A is discoverable on the local Sui network.');

    console.log();
    console.log(stepLabel(6, '🤝', 'Running the two-agent task flow...'));
    const execution = await discoverAndExecute({
      networkConfig: demo.networkConfig,
      keypair: agentB.keypair,
      blobStore,
      input: 'Hello from Agent B!',
      log: (message) => console.log(`    ${message}`),
    });
    console.log(`    Task ${execution.taskId} reached RELEASED state.`);
    console.log(`    Result blob: ${execution.outputBlobId}`);

    console.log();
    console.log(stepLabel(7, '💸', 'Showing payment flow and final balances...'));
    const finalBalances = {
      agentA: await demo.getBalance(agentA.address),
      agentB: await demo.getBalance(agentB.address),
    };
    printBalanceLine('Agent A before release', execution.balancesBeforeRelease.provider);
    printBalanceLine('Agent A after release', execution.balancesAfterRelease.provider);
    printBalanceLine('Agent B before release', execution.balancesBeforeRelease.requester);
    printBalanceLine('Agent B after release', execution.balancesAfterRelease.requester);
    console.log(`    Agent A payment delta: +${color.green(formatMistAsSui(execution.balancesAfterRelease.provider - execution.balancesBeforeRelease.provider))} SUI`);
    console.log(`    Agent B release tx delta: ${color.yellow(formatMistAsSui(execution.balancesAfterRelease.requester - execution.balancesBeforeRelease.requester))} SUI`);
    printBalanceLine('Agent A final', finalBalances.agentA);
    printBalanceLine('Agent B final', finalBalances.agentB);
    console.log(`    Agent B total delta: ${formatMistAsSui(finalBalances.agentB - startingBalances.agentB)} SUI`);
    console.log(`    Processed tasks: ${providerListener.processedTaskIds.join(', ')}`);
    console.log(color.green('    ✅ End-to-end payment flowed from Agent B to Agent A.'));

    await cleanup(0);
  } catch (error) {
    await cleanup(1, error);
  }
}

function printBanner(): void {
  console.log(divider);
  console.log(color.cyan('🤖 Agentic Mesh two-agent demo'));
  console.log(color.magenta('Agent A discovers work. Agent B discovers Agent A. SUI moves on-chain.'));
  console.log(divider);
}

function stepLabel(step: number, emoji: string, message: string): string {
  return `${color.blue(`[${step}/8]`)} ${emoji} ${message}`;
}

function printBalanceLine(label: string, balance: bigint): void {
  console.log(`    ${label.padEnd(22)} ${formatMistAsSui(balance)} SUI`);
}

void run();
