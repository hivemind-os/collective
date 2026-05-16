#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { SessionExpiredError } from '@hivemind-os/collective-core';

import { handleAnalytics } from './commands/analytics.js';
import { handleAuth } from './commands/auth.js';
import { handleConfig } from './commands/config.js';
import { handleConnect } from './commands/connect.js';
import { handleDaemon } from './commands/daemon.js';
import { handleDiscover } from './commands/discover.js';
import { handleDispute } from './commands/dispute.js';
import { handleInit } from './commands/init.js';
import { handleLogs } from './commands/logs.js';
import { handleMarketplace } from './commands/marketplace.js';
import { handleMetering } from './commands/metering.js';
import { handleMultiExecute } from './commands/multi-execute.js';
import { handlePolicy } from './commands/policy.js';
import { handleRegister } from './commands/register.js';
import { handleRelayRegistry } from './commands/relay-registry.js';
import { handleStake } from './commands/stake.js';
import { handleTask } from './commands/task.js';
import { handleWallet } from './commands/wallet.js';
import { error, info } from './utils/output.js';

const VERSION = '0.1.0';

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  const subcommand = args[1];

  switch (command) {
    case 'init':
      return await handleInit(args.slice(1));
    case 'connect':
      return await handleConnect(args.slice(1));
    case 'daemon':
      return await handleDaemon(subcommand, args.slice(2));
    case 'auth':
      return await handleAuth(subcommand, args.slice(2));
    case 'register':
      return await handleRegister(args.slice(1));
    case 'config':
      return await handleConfig(args.slice(1));
    case 'analytics':
      return await handleAnalytics(subcommand, args.slice(2));
    case 'policy':
      return await handlePolicy(subcommand, args.slice(2));
    case 'wallet':
      return await handleWallet(subcommand, args.slice(2));
    case 'discover':
      return await handleDiscover(args.slice(1));
    case 'dispute':
      return await handleDispute(subcommand, args.slice(2));
    case 'stake':
      return await handleStake(subcommand, args.slice(2));
    case 'relay':
      return await handleRelayRegistry(subcommand, args.slice(2));
    case 'task':
      return await handleTask(subcommand, args.slice(2));
    case 'logs':
      return await handleLogs(args.slice(1));
    case 'marketplace':
      return await handleMarketplace(subcommand, args.slice(2));
    case 'metering':
      return await handleMetering(subcommand, args.slice(2));
    case 'multi-execute':
      return await handleMultiExecute(args.slice(1));
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return 0;
    case '--version':
    case '-v':
      printVersion();
      return 0;
    default:
      printHelp();
      return command ? 1 : 0;
  }
}

export function printHelp(): void {
  console.log(`Agentic Mesh CLI

Usage:
  mesh <command> [options]

Commands:
  init                 First-time setup for your local mesh identity
  connect              Start the MCP shim bridge
  daemon <cmd>         Manage the background daemon (start|stop|status)
  auth <cmd>           Inspect or refresh daemon auth (status|reauth)
  register             Register this node as a provider
  config [subcmd]      Show or update config values
  analytics <cmd>      Query indexer analytics (summary|top-providers|task-volume)
  policy set           Update spending limits
  wallet <cmd>         Wallet tools (balance|fund|address)
  discover <cap>       Find providers for a capability
  dispute <cmd>        Manage disputes (open|respond|accept|status)
  marketplace <cmd>    Marketplace tools (post|browse|bid|accept-bid)
  metering <cmd>       Metered task tools (execute|verify|status)
  multi-execute        Execute across multiple providers
  stake <cmd>          Manage staking (deposit|status|withdraw)
  relay <cmd>          Manage community relays (register|list|heartbeat|deactivate)
  task status <id>     Inspect a task on Sui
  logs [--follow]      Show daemon logs
  help                 Show this help text
  --version            Print the CLI version`);
}

export function printVersion(): void {
  console.log(VERSION);
}

async function main(): Promise<void> {
  const exitCode = await runCli();
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(message);
    if (isAuthError(caught)) {
      info('Run "mesh auth status" to inspect the session or "mesh auth reauth" to open the daemon portal.');
    }
    process.exit(1);
  });
}

function isAuthError(errorToCheck: unknown): boolean {
  if (errorToCheck instanceof SessionExpiredError) {
    return true;
  }

  return errorToCheck instanceof Error && /authentication expired|re-authenticate via the daemon portal/i.test(errorToCheck.message);
}
