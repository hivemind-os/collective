import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { PortAllocator } from './port-allocator.js';
import { ProcessTracker } from './process-tracker.js';
import type { TestWallet } from './funded-wallet.js';
import {
  CONTRACT_DEPLOY_TIMEOUT,
  FAUCET_TIMEOUT,
  SUI_STARTUP_TIMEOUT,
} from './timeouts.js';

const harnessDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const packageDirectory = resolve(harnessDirectory, '..', '..');
const repositoryRoot = resolve(packageDirectory, '..', '..');

export interface ContractAddresses {
  packageId: string;
  registryId: string;
}

export interface SuiTestNetworkOptions {
  contractsPath?: string;
  processTracker?: ProcessTracker;
  portAllocator?: PortAllocator;
  suiBinary?: string;
  tmpRoot?: string;
  workingDirectory?: string;
}

interface PublishObjectChange {
  type?: string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
}

interface PublishCommandOutput {
  objectChanges?: PublishObjectChange[];
}

interface PublishClientConfig {
  clientConfigPath: string;
  clientEnvAlias: string;
  deployerAddress: string;
}

export class SuiTestNetwork {
  private readonly contractsPath: string;
  private readonly portAllocator: PortAllocator;
  private readonly processTracker: ProcessTracker;
  private readonly suiBinary: string;
  private readonly tmpRoot: string;
  private readonly workingDirectory: string;

  private reservedPorts: number[] = [];
  private suiProcess?: ChildProcess;
  private suiProcessError?: Error;
  private tmpDir?: string;
  private suiEnvironment?: NodeJS.ProcessEnv;
  private _client?: SuiClient;
  private _contractAddresses?: ContractAddresses;
  private _faucetUrl?: string;
  private _rpcUrl?: string;

  constructor(options: SuiTestNetworkOptions = {}) {
    this.workingDirectory = options.workingDirectory ?? repositoryRoot;
    this.contractsPath =
      options.contractsPath ?? resolve(this.workingDirectory, 'contracts', 'agentic_mesh');
    this.processTracker = options.processTracker ?? new ProcessTracker();
    this.portAllocator = options.portAllocator ?? new PortAllocator();
    this.suiBinary = options.suiBinary ?? resolveSuiBinary();
    this.tmpRoot = options.tmpRoot ?? resolve(this.workingDirectory, 'sui_tmp');
  }

  get contractAddresses(): ContractAddresses {
    if (!this._contractAddresses) {
      throw new Error('Sui test network contracts have not been deployed yet.');
    }

    return this._contractAddresses;
  }

  get client(): SuiClient {
    if (!this._client) {
      throw new Error('Sui test network is not started yet.');
    }

    return this._client;
  }

  get rpcUrl(): string {
    if (!this._rpcUrl) {
      throw new Error('Sui test network is not started yet.');
    }

    return this._rpcUrl;
  }

  get faucetUrl(): string {
    if (!this._faucetUrl) {
      throw new Error('Sui test network is not started yet.');
    }

    return this._faucetUrl;
  }

  async start(): Promise<void> {
    if (this.suiProcess) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.startOnce();
        return;
      } catch (error) {
        lastError = error;
        await this.cleanupFailedStart();
        if (attempt >= 3) {
          throw error;
        }

        await delay(attempt * 500);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async startOnce(): Promise<void> {
    this.reservedPorts = await this.portAllocator.allocate(2);
    const [rpcPort, faucetPort] = this.reservedPorts;

    this._rpcUrl = `http://127.0.0.1:${rpcPort}`;
    this._faucetUrl = `http://127.0.0.1:${faucetPort}`;
    this._client = new SuiClient({ url: this._rpcUrl });

    this.tmpDir = resolve(this.tmpRoot, `test-network-${randomUUID()}`);
    await mkdir(this.tmpDir, { recursive: true });

    this.suiEnvironment = {
      ...process.env,
      TMPDIR: this.tmpDir,
      TMP: this.tmpDir,
      TEMP: this.tmpDir,
      HOME: this.tmpDir,
      USERPROFILE: this.tmpDir,
    };

    const startArgs = [
      'start',
      `--with-faucet=127.0.0.1:${faucetPort}`,
      '--force-regenesis',
      '--fullnode-rpc-port',
      String(rpcPort),
    ];

    const suiProcess = spawn(this.suiBinary, startArgs, {
      cwd: this.workingDirectory,
      env: this.suiEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    suiProcess.once('error', (error) => {
      this.suiProcessError = error instanceof Error ? error : new Error(String(error));
    });

    this.suiProcess = suiProcess;
    if (suiProcess.pid) {
      this.processTracker.track(suiProcess.pid, 'sui-localnet');
    }

    await this.waitForRpcReady();

    const publishClient = await this.createPublishClient();
    const publishOutput = await this.publishContracts(publishClient);

    this._contractAddresses = this.parsePublishOutput(publishOutput);
  }

  async createFundedWallet(amount: bigint = 1_000_000_000n): Promise<TestWallet> {
    if (!this._client) {
      throw new Error('Cannot create funded wallet before starting the Sui test network.');
    }

    const keypair = new Ed25519Keypair();
    const address = keypair.getPublicKey().toSuiAddress();

    await this.requestFromFaucet(address, amount);

    return {
      address,
      keypair,
      client: this._client,
    };
  }

  async stop(): Promise<void> {
    try {
      await this.processTracker.cleanup();
    } finally {
      await this.cleanupFailedStart();
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    await this.processTracker.cleanup().catch(() => undefined);
    await this.portAllocator.release(this.reservedPorts);
    this.reservedPorts = [];

    if (this.tmpDir) {
      await removeDirectoryWithRetries(this.tmpDir).catch(() => undefined);
    }

    this.suiProcess = undefined;
    this.suiProcessError = undefined;
    this.suiEnvironment = undefined;
    this.tmpDir = undefined;
    this._client = undefined;
    this._contractAddresses = undefined;
    this._faucetUrl = undefined;
    this._rpcUrl = undefined;
  }

  private async waitForRpcReady(timeoutMs = SUI_STARTUP_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.suiProcessError) {
        throw this.suiProcessError;
      }

      if (this.suiProcess && this.suiProcess.exitCode !== null) {
        throw new Error(`Local Sui process exited early with code ${this.suiProcess.exitCode}.`);
      }

      try {
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_getLatestCheckpointSequenceNumber',
            params: [],
          }),
          signal: AbortSignal.timeout(2_000),
        });

        if (response.ok) {
          return;
        }
      } catch {
        // Keep polling until the timeout is reached.
      }

      await delay(500);
    }

    throw new Error(`Timed out waiting ${timeoutMs}ms for local Sui RPC readiness.`);
  }

  private async requestFromFaucet(address: string, amount: bigint): Promise<void> {
    const endpoints = [`${this.faucetUrl}/v1/gas`, `${this.faucetUrl}/gas`];
    const bodies = [
      {
        FixedAmountRequest: {
          recipient: address,
        },
      },
      {
        recipient: address,
        amount: amount.toString(),
      },
    ];
    const deadline = Date.now() + Math.max(FAUCET_TIMEOUT * 3, 30_000);

    while (Date.now() < deadline) {
      for (const endpoint of endpoints) {
        for (const body of bodies) {
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(FAUCET_TIMEOUT),
            });

            if (response.ok) {
              return;
            }
          } catch {
            // Try the next known faucet endpoint shape or wait for the faucet to finish booting.
          }
        }
      }

      await delay(500);
    }

    throw new Error(`Failed to fund test wallet ${address} from faucet at ${this.faucetUrl}.`);
  }

  private parsePublishOutput(rawOutput: string): ContractAddresses {
    const parsedOutput = this.tryParsePublishOutput(rawOutput);
    const objectChanges = parsedOutput?.objectChanges ?? [];

    const packageId =
      objectChanges.find((change) => change.type === 'published' && Boolean(change.packageId))?.packageId ??
      matchFirst(rawOutput, /"packageId"\s*:\s*"([^"]+)"/) ??
      matchFirst(rawOutput, /Package(?: ID)?:\s*(0x[a-fA-F0-9]+)/);

    const registryId =
      objectChanges.find(
        (change) =>
          Boolean(change.objectId) &&
          typeof change.objectType === 'string' &&
          /::registry::Registry$/i.test(change.objectType),
      )?.objectId ??
      matchFirst(rawOutput, /"objectType"\s*:\s*"[^"]*::registry::Registry"[\s\S]*?"objectId"\s*:\s*"([^"]+)"/) ??
      matchFirst(rawOutput, /Registry(?: ID)?:\s*(0x[a-fA-F0-9]+)/);

    if (!packageId || !registryId) {
      throw new Error('Unable to extract packageId and registryId from Sui publish output.');
    }

    return {
      packageId,
      registryId,
    };
  }

  private tryParsePublishOutput(rawOutput: string): PublishCommandOutput | undefined {
    try {
      const parsed = JSON.parse(rawOutput) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }

      const objectChangesValue = parsed.objectChanges;
      if (!Array.isArray(objectChangesValue)) {
        return undefined;
      }

      const objectChanges = objectChangesValue
        .filter(isRecord)
        .map((change) => ({
          type: asString(change.type),
          packageId: asString(change.packageId),
          objectId: asString(change.objectId),
          objectType: asString(change.objectType),
        }));

      return { objectChanges };
    } catch {
      return undefined;
    }
  }

  private async createPublishClient(): Promise<PublishClientConfig> {
    if (!this.tmpDir) {
      throw new Error('Sui temp directory has not been initialized yet.');
    }

    const clientConfigPath = resolve(this.tmpDir, 'client.yaml');
    const clientEnvAlias = `mesh-local-${Date.now()}`;
    const deployerAlias = `deployer-${randomUUID().slice(0, 8)}`;
    const addressOutput = await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, '-y', 'new-address', 'ed25519', deployerAlias, '--json'],
      CONTRACT_DEPLOY_TIMEOUT,
    );
    const deployerAddress = matchFirst(addressOutput, /"address"\s*:\s*"([^"]+)"/);
    if (!deployerAddress) {
      throw new Error('Unable to determine deployer address from Sui client output.');
    }

    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'new-env', '--alias', clientEnvAlias, '--rpc', this.rpcUrl, '--json'],
      CONTRACT_DEPLOY_TIMEOUT,
    );
    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'switch', '--env', clientEnvAlias],
      CONTRACT_DEPLOY_TIMEOUT,
    );
    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'switch', '--address', deployerAddress],
      CONTRACT_DEPLOY_TIMEOUT,
    );
    await this.requestFromFaucet(deployerAddress, 1_000_000_000n);

    return {
      clientConfigPath,
      clientEnvAlias,
      deployerAddress,
    };
  }

  private async publishContracts(publishClient: PublishClientConfig): Promise<string> {
    const publishArgs = [
      'client',
      '--client.config',
      publishClient.clientConfigPath,
      '--client.env',
      publishClient.clientEnvAlias,
      'test-publish',
      this.contractsPath,
      '--sender',
      publishClient.deployerAddress,
      '--gas-budget',
      '100000000',
      '--json',
    ];

    try {
      return await this.runSuiCommand([...publishArgs, '--build-env', 'testnet'], CONTRACT_DEPLOY_TIMEOUT);
    } catch (error) {
      if (!isUnsupportedBuildEnvError(error)) {
        throw error;
      }
    }

    return this.runSuiCommand(publishArgs, CONTRACT_DEPLOY_TIMEOUT);
  }

  private async runSuiCommand(args: string[], timeoutMs: number): Promise<string> {
    const options: SpawnOptionsWithoutStdio = {
      cwd: this.workingDirectory,
      env: this.suiEnvironment,
    };

    return runCommand(this.suiBinary, args, options, timeoutMs);
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
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
        reject(new Error(stderr || stdout || `${command} exited with code ${code ?? 'unknown'}.`));
        return;
      }

      resolvePromise(stdout.trim());
    });
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function isUnsupportedBuildEnvError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /--build-env|build-env/i.test(message) && /unexpected|unknown|unrecognized|wasn't expected|not allowed/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchFirst(value: string, expression: RegExp): string | undefined {
  return expression.exec(value)?.[1];
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

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
