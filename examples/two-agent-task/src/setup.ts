import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MeshSuiClient } from '@agentic-mesh/core';
import type { NetworkConfig } from '@agentic-mesh/types';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const SUI_STARTUP_TIMEOUT_MS = 60_000;
const CONTRACT_DEPLOY_TIMEOUT_MS = 60_000;
const FAUCET_TIMEOUT_MS = 30_000;
const WALLET_FUNDING_TIMEOUT_MS = 30_000;
const PROCESS_OUTPUT_LIMIT = 100;
const MIST_PER_SUI = 1_000_000_000n;

export interface DemoWallet {
  name: string;
  address: string;
  keypair: Ed25519Keypair;
  client: MeshSuiClient;
}

export interface ContractAddresses {
  packageId: string;
  registryId: string;
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

export class LocalSuiDemo {
  readonly exampleRoot: string;
  readonly repositoryRoot: string;
  readonly contractsPath: string;
  readonly runtimeDir: string;
  readonly blobStoreDir: string;
  readonly providerCursorDbPath: string;

  private readonly suiBinary: string;
  private readonly suiHomeDir: string;
  private readonly suiOutput: string[] = [];

  private reservedPorts: number[] = [];
  private rpcClient?: SuiClient;
  private rpcUrl?: string;
  private faucetUrl?: string;
  private contractAddresses?: ContractAddresses;
  private suiEnvironment?: NodeJS.ProcessEnv;
  private suiProcess?: ChildProcess;
  private suiProcessError?: Error;

  constructor() {
    this.exampleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    this.repositoryRoot = resolve(this.exampleRoot, '..', '..');
    this.contractsPath = resolve(this.exampleRoot, '..', '..', 'contracts', 'agentic_mesh');
    this.runtimeDir = join(this.exampleRoot, '.runtime', `run-${randomUUID()}`);
    this.blobStoreDir = join(this.runtimeDir, 'blobs');
    this.providerCursorDbPath = join(this.runtimeDir, 'agent-a-cursors.sqlite');
    this.suiHomeDir = join(this.runtimeDir, 'sui-home');
    this.suiBinary = resolveSuiBinary();
  }

  get networkConfig(): NetworkConfig {
    if (!this.rpcUrl || !this.faucetUrl || !this.contractAddresses) {
      throw new Error('The local Sui demo environment is not ready yet.');
    }

    return {
      rpcUrl: this.rpcUrl,
      faucetUrl: this.faucetUrl,
      packageId: this.contractAddresses.packageId,
      registryId: this.contractAddresses.registryId,
    };
  }

  async start(): Promise<void> {
    if (this.suiProcess) {
      return;
    }

    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.blobStoreDir, { recursive: true });
    await mkdir(this.suiHomeDir, { recursive: true });

    this.reservedPorts = await allocatePorts(2);
    const [rpcPort, faucetPort] = this.reservedPorts;
    this.rpcUrl = `http://127.0.0.1:${rpcPort}`;
    this.faucetUrl = `http://127.0.0.1:${faucetPort}`;
    this.rpcClient = new SuiClient({ url: this.rpcUrl });

    this.suiEnvironment = {
      ...process.env,
      TMPDIR: this.suiHomeDir,
      TMP: this.suiHomeDir,
      TEMP: this.suiHomeDir,
      HOME: this.suiHomeDir,
      USERPROFILE: this.suiHomeDir,
    };

    const startArgs = [
      'start',
      `--with-faucet=127.0.0.1:${faucetPort}`,
      '--force-regenesis',
      '--fullnode-rpc-port',
      String(rpcPort),
    ];

    this.suiProcess = spawn(this.suiBinary, startArgs, {
      cwd: this.repositoryRoot,
      env: this.suiEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.suiProcess.once('error', (error) => {
      this.suiProcessError = error instanceof Error ? error : new Error(String(error));
    });
    this.suiProcess.stdout?.on('data', (chunk: Buffer | string) => {
      captureProcessOutput(this.suiOutput, chunk.toString());
    });
    this.suiProcess.stderr?.on('data', (chunk: Buffer | string) => {
      captureProcessOutput(this.suiOutput, chunk.toString());
    });

    await this.waitForRpcReady();

    const publishClient = await this.createPublishClient();
    const publishOutput = await this.publishContracts(publishClient);
    this.contractAddresses = this.parsePublishOutput(publishOutput);
  }

  async createFundedWallet(name: string, minBalanceMist = MIST_PER_SUI): Promise<DemoWallet> {
    if (!this.rpcClient) {
      throw new Error('Start the local Sui demo before creating wallets.');
    }

    const keypair = new Ed25519Keypair();
    const address = keypair.getPublicKey().toSuiAddress();
    await fundAddress(this.rpcClient, this.faucetUrl ?? '', address, minBalanceMist);

    return {
      name,
      address,
      keypair,
      client: new MeshSuiClient(this.networkConfig),
    };
  }

  async getBalance(address: string): Promise<bigint> {
    if (!this.rpcClient) {
      throw new Error('Start the local Sui demo before reading balances.');
    }

    const balance = await this.rpcClient.getBalance({ owner: address });
    return BigInt(balance.totalBalance);
  }

  async stop(): Promise<void> {
    const pid = this.suiProcess?.pid;
    this.suiProcess = undefined;

    if (pid) {
      await killProcess(pid).catch(() => undefined);
    }

    await removeDirectoryWithRetries(this.runtimeDir).catch(() => undefined);

    this.contractAddresses = undefined;
    this.faucetUrl = undefined;
    this.rpcClient = undefined;
    this.rpcUrl = undefined;
    this.reservedPorts = [];
    this.suiEnvironment = undefined;
    this.suiProcessError = undefined;
  }

  private async waitForRpcReady(timeoutMs = SUI_STARTUP_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.suiProcessError) {
        throw this.suiProcessError;
      }

      if (this.suiProcess && this.suiProcess.exitCode !== null) {
        throw new Error(`Local Sui process exited early with code ${this.suiProcess.exitCode}.\n${this.suiOutput.join('\n')}`);
      }

      try {
        const response = await fetch(this.rpcUrl ?? '', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
        // Keep polling until the local fullnode is ready.
      }

      await delay(500);
    }

    throw new Error(`Timed out waiting ${timeoutMs}ms for local Sui RPC readiness.\n${this.suiOutput.join('\n')}`);
  }

  private async createPublishClient(): Promise<PublishClientConfig> {
    const clientConfigPath = resolve(this.suiHomeDir, 'client.yaml');
    const clientEnvAlias = `mesh-demo-${Date.now()}`;
    const deployerAlias = `demo-deployer-${randomUUID().slice(0, 8)}`;

    const addressOutput = await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, '-y', 'new-address', 'ed25519', deployerAlias, '--json'],
      CONTRACT_DEPLOY_TIMEOUT_MS,
    );
    const deployerAddress = matchFirst(addressOutput, /"address"\s*:\s*"([^"]+)"/);
    if (!deployerAddress) {
      throw new Error(`Unable to determine the deployer address.\n${addressOutput}`);
    }

    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'new-env', '--alias', clientEnvAlias, '--rpc', this.rpcUrl ?? '', '--json'],
      CONTRACT_DEPLOY_TIMEOUT_MS,
    );
    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'switch', '--env', clientEnvAlias],
      CONTRACT_DEPLOY_TIMEOUT_MS,
    );
    await this.runSuiCommand(
      ['client', '--client.config', clientConfigPath, 'switch', '--address', deployerAddress],
      CONTRACT_DEPLOY_TIMEOUT_MS,
    );
    await fundAddress(this.rpcClient ?? new SuiClient({ url: this.rpcUrl ?? '' }), this.faucetUrl ?? '', deployerAddress, MIST_PER_SUI);

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
      '500000000',
      '--json',
    ];

    try {
      return await this.runSuiCommand([...publishArgs, '--build-env', 'testnet'], CONTRACT_DEPLOY_TIMEOUT_MS);
    } catch (error) {
      if (!isUnsupportedBuildEnvError(error)) {
        throw error;
      }
    }

    return await this.runSuiCommand(publishArgs, CONTRACT_DEPLOY_TIMEOUT_MS);
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
      throw new Error(`Unable to extract packageId and registryId from publish output.\n${rawOutput}`);
    }

    return { packageId, registryId };
  }

  private tryParsePublishOutput(rawOutput: string): PublishCommandOutput | undefined {
    try {
      const parsed = JSON.parse(rawOutput) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.objectChanges)) {
        return undefined;
      }

      return {
        objectChanges: parsed.objectChanges.filter(isRecord).map((change) => ({
          type: asString(change.type),
          packageId: asString(change.packageId),
          objectId: asString(change.objectId),
          objectType: asString(change.objectType),
        })),
      };
    } catch {
      return undefined;
    }
  }

  private async runSuiCommand(args: string[], timeoutMs: number): Promise<string> {
    return await runCommand(
      this.suiBinary,
      args,
      {
        cwd: this.repositoryRoot,
        env: this.suiEnvironment,
      },
      timeoutMs,
    );
  }
}

export async function waitForCondition<T>(
  predicate: () => Promise<T | undefined>,
  timeoutMs: number,
  failureMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  if (lastError instanceof Error) {
    throw new Error(`${failureMessage}: ${lastError.message}`);
  }

  throw new Error(failureMessage);
}

export function formatMistAsSui(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / MIST_PER_SUI;
  const fractional = (absolute % MIST_PER_SUI).toString().padStart(9, '0');
  return `${sign}${whole}.${fractional}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export async function removeDirectoryWithRetries(path: string, attempts = 10): Promise<void> {
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

async function fundAddress(
  rpcClient: SuiClient,
  faucetUrl: string,
  address: string,
  minBalanceMist: bigint,
): Promise<void> {
  const deadline = Date.now() + WALLET_FUNDING_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await requestFromFaucet(faucetUrl, address).catch(() => undefined);

    try {
      const balance = await rpcClient.getBalance({ owner: address });
      if (BigInt(balance.totalBalance) >= minBalanceMist) {
        return;
      }
    } catch {
      // Keep polling until the faucet transfer settles.
    }

    await delay(1_000);
  }

  throw new Error(`Failed to fund ${address} from the local faucet.`);
}

async function requestFromFaucet(faucetUrl: string, address: string): Promise<void> {
  const endpoints = [`${faucetUrl}/v1/gas`, `${faucetUrl}/gas`];
  const bodies = [
    { FixedAmountRequest: { recipient: address } },
    { recipient: address, amount: MIST_PER_SUI.toString() },
  ];
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const endpoint of endpoints) {
      for (const body of bodies) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });

          if (response.ok) {
            return;
          }
        } catch {
          // Try the next faucet shape.
        }
      }
    }

    await delay(500);
  }

  throw new Error(`The local faucet at ${faucetUrl} never became ready.`);
}

async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(await findFreePort());
  }
  return ports;
}

function findFreePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to determine a free port.'));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise(port);
      });
    });
  });
}

async function killProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/T', '/F', '/PID', String(pid)], {}, 15_000).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|there is no running instance|cannot find the process/i.test(message)) {
        throw error;
      }
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (isMissingProcessError(error)) {
      return;
    }
    throw error;
  }

  await delay(250);

  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
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

function captureProcessOutput(lines: string[], chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    lines.push(trimmed);
    if (lines.length > PROCESS_OUTPUT_LIMIT) {
      lines.shift();
    }
  }
}

function isUnsupportedBuildEnvError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /--build-env|build-env/i.test(message) && /unexpected|unknown|unrecognized|wasn't expected|not allowed/i.test(message);
}

function isMissingProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function matchFirst(value: string, expression: RegExp): string | undefined {
  return expression.exec(value)?.[1];
}
