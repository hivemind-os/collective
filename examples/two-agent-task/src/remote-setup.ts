import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MeshSuiClient } from '@hivemind-os/collective-core';
import type { NetworkConfig } from '@hivemind-os/collective-types';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import type { DemoWallet, SuiDemo } from './demo-interface.js';
import type { NetworkMode, RemoteNetworkInfo } from './network-config.js';

const MIST_PER_SUI = 1_000_000_000n;
const CONTRACT_DEPLOY_TIMEOUT_MS = 120_000;
const FAUCET_TIMEOUT_MS = 60_000;
const WALLET_FUNDING_TIMEOUT_MS = 60_000;

export class RemoteSuiDemo implements SuiDemo {
  readonly blobStoreDir: string;
  readonly providerCursorDbPath: string;

  private readonly suiBinary: string;
  private readonly network: NetworkMode;
  private readonly remoteInfo: RemoteNetworkInfo;
  private readonly runtimeDir: string;
  private readonly repositoryRoot: string;

  private rpcClient?: SuiClient;
  private contractAddresses?: { packageId: string; registryId: string };

  constructor(network: 'devnet' | 'testnet', remoteInfo: RemoteNetworkInfo) {
    const exampleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    this.repositoryRoot = resolve(exampleRoot, '..', '..');
    this.network = network;
    this.remoteInfo = remoteInfo;
    this.suiBinary = resolveSuiBinary();
    this.runtimeDir = join(exampleRoot, '.runtime', `run-${randomUUID()}`);
    this.blobStoreDir = join(this.runtimeDir, 'blobs');
    this.providerCursorDbPath = join(this.runtimeDir, 'agent-a-cursors.sqlite');
  }

  get networkConfig(): NetworkConfig {
    if (!this.contractAddresses) {
      throw new Error('Remote demo environment is not ready yet. Call start() first.');
    }

    return {
      rpcUrl: this.remoteInfo.rpcUrl,
      faucetUrl: this.remoteInfo.faucetUrl,
      packageId: this.contractAddresses.packageId,
      registryId: this.contractAddresses.registryId,
    };
  }

  async start(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.blobStoreDir, { recursive: true });

    this.rpcClient = new SuiClient({ url: this.remoteInfo.rpcUrl });

    // Allow reusing a previously deployed package/registry
    const envPackageId = process.env.SUI_PACKAGE_ID;
    const envRegistryId = process.env.SUI_REGISTRY_ID;

    if (envPackageId && envRegistryId) {
      this.contractAddresses = { packageId: envPackageId, registryId: envRegistryId };
      return;
    }

    // Compile contracts locally (no network needed)
    const compiledModules = await this.compileContracts();

    // Create a deployer keypair, fund it via faucet, and publish using the TypeScript SDK
    const deployerKeypair = new Ed25519Keypair();
    const deployerAddress = deployerKeypair.getPublicKey().toSuiAddress();
    await this.fundAddress(deployerAddress, MIST_PER_SUI);

    this.contractAddresses = await this.publishWithSdk(compiledModules, deployerKeypair);
  }

  async stop(): Promise<void> {
    await removeDirectoryWithRetries(this.runtimeDir).catch(() => undefined);
    this.rpcClient = undefined;
    this.contractAddresses = undefined;
  }

  async createFundedWallet(name: string, minBalanceMist = MIST_PER_SUI): Promise<DemoWallet> {
    if (!this.rpcClient) {
      throw new Error('Start the remote demo before creating wallets.');
    }

    const keypair = new Ed25519Keypair();
    const address = keypair.getPublicKey().toSuiAddress();
    await this.fundAddress(address, minBalanceMist);

    return {
      name,
      address,
      keypair,
      client: new MeshSuiClient(this.networkConfig),
    };
  }

  async getBalance(address: string): Promise<bigint> {
    if (!this.rpcClient) {
      throw new Error('Start the remote demo before reading balances.');
    }

    const balance = await this.rpcClient.getBalance({ owner: address });
    return BigInt(balance.totalBalance);
  }

  private async fundAddress(address: string, minBalanceMist: bigint): Promise<void> {
    const deadline = Date.now() + WALLET_FUNDING_TIMEOUT_MS;
    let lastStatus = 0;
    let lastBody = '';

    while (Date.now() < deadline) {
      const result = await this.requestFromFaucet(address);
      if (result.success) {
        // Wait for the balance to appear
        const balanceDeadline = Date.now() + 30_000;
        while (Date.now() < balanceDeadline) {
          try {
            const balance = await this.rpcClient!.getBalance({ owner: address });
            if (BigInt(balance.totalBalance) >= minBalanceMist) {
              return;
            }
          } catch {
            // Keep polling
          }

          await delay(1_000);
        }
      }

      lastStatus = result.status;
      lastBody = result.body;

      if (result.status === 429) {
        const retryAfter = result.retryAfterMs ?? 10_000;
        await delay(retryAfter);
        continue;
      }

      await delay(2_000);
    }

    throw new Error(
      `Failed to fund ${address} from ${this.network} faucet (last status: ${lastStatus}).` +
      (lastBody ? `\nResponse: ${lastBody.slice(0, 500)}` : ''),
    );
  }

  private async requestFromFaucet(address: string): Promise<{ success: boolean; status: number; body: string; retryAfterMs?: number }> {
    const endpoints = [`${this.remoteInfo.faucetUrl}/v2/gas`, `${this.remoteInfo.faucetUrl}/v1/gas`, `${this.remoteInfo.faucetUrl}/gas`];
    const bodies = [
      { FixedAmountRequest: { recipient: address } },
      { recipient: address, amount: MIST_PER_SUI.toString() },
    ];

    for (const endpoint of endpoints) {
      for (const body of bodies) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(FAUCET_TIMEOUT_MS),
          });

          if (response.ok) {
            const text = await response.text();
            // Some endpoints return 200 with a "Failure" status in the JSON body
            if (text.includes('"Failure"')) {
              continue;
            }
            return { success: true, status: response.status, body: text };
          }

          if (response.status === 429) {
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
            return { success: false, status: 429, body: await response.text(), retryAfterMs };
          }
        } catch {
          // Try next endpoint/body format
        }
      }
    }

    return { success: false, status: 0, body: 'All faucet endpoints failed.' };
  }

  private async compileContracts(): Promise<{ modules: string[]; dependencies: string[] }> {
    const contractsPath = resolve(this.repositoryRoot, 'contracts', 'agentic_mesh');
    const buildArgs = ['move', 'build', '--dump-bytecode-as-base64', '--path', contractsPath];

    let output: string;
    try {
      output = await runCommand(this.suiBinary, [...buildArgs, '--build-env', this.network], { cwd: this.repositoryRoot }, CONTRACT_DEPLOY_TIMEOUT_MS);
    } catch (error) {
      if (!isUnsupportedBuildEnvError(error)) {
        throw error;
      }
      output = await runCommand(this.suiBinary, buildArgs, { cwd: this.repositoryRoot }, CONTRACT_DEPLOY_TIMEOUT_MS);
    }

    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.modules) || !Array.isArray(parsed.dependencies)) {
      throw new Error(`Unexpected output from sui move build:\n${output.slice(0, 500)}`);
    }

    return {
      modules: parsed.modules as string[],
      dependencies: parsed.dependencies as string[],
    };
  }

  private async publishWithSdk(
    compiled: { modules: string[]; dependencies: string[] },
    deployerKeypair: Ed25519Keypair,
  ): Promise<{ packageId: string; registryId: string }> {
    const tx = new Transaction();
    const [upgradeCap] = tx.publish({
      modules: compiled.modules,
      dependencies: compiled.dependencies,
    });
    tx.transferObjects([upgradeCap], deployerKeypair.getPublicKey().toSuiAddress());
    tx.setGasBudget(500_000_000);

    const response = await this.rpcClient!.signAndExecuteTransaction({
      transaction: tx,
      signer: deployerKeypair,
      options: {
        showObjectChanges: true,
        showEffects: true,
      },
    });

    await this.rpcClient!.waitForTransaction({ digest: response.digest });

    const objectChanges = response.objectChanges ?? [];

    const publishedChange = objectChanges.find(
      (change) => 'type' in change && change.type === 'published',
    );
    const packageId = publishedChange && 'packageId' in publishedChange ? publishedChange.packageId : undefined;

    const registryChange = objectChanges.find(
      (change) =>
        'type' in change &&
        change.type === 'created' &&
        'objectType' in change &&
        typeof change.objectType === 'string' &&
        /::registry::Registry$/.test(change.objectType),
    );
    const registryId = registryChange && 'objectId' in registryChange ? registryChange.objectId : undefined;

    if (!packageId || !registryId) {
      throw new Error(
        `Unable to extract packageId and registryId from publish response.\n` +
        `Digest: ${response.digest}\n` +
        `Object changes: ${JSON.stringify(objectChanges, null, 2)}`,
      );
    }

    return { packageId: String(packageId), registryId: String(registryId) };
  }
}

function resolveSuiBinary(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local');
    const localBinary = resolve(localAppData, 'bin', 'sui.exe');
    if (existsSync(localBinary)) {
      return localBinary;
    }
  }

  return 'sui';
}

async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  timeoutMs: number,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? 'unknown'}.`));
        return;
      }

      resolvePromise(stdout.trim());
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function removeDirectoryWithRetries(path: string, attempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }

      await delay(attempt * 250);
    }
  }
}

function isUnsupportedBuildEnvError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/not present in Move\.toml/i.test(message)) {
    return true;
  }
  return /--build-env|build-env/i.test(message) && /unexpected|unknown|unrecognized|wasn't expected|not allowed/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
