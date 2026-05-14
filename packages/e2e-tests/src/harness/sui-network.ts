import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
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
const repositoryRoot = resolve(packageDirectory, '..', '..', '..');

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

export class SuiTestNetwork {
  private readonly contractsPath: string;
  private readonly portAllocator: PortAllocator;
  private readonly processTracker: ProcessTracker;
  private readonly suiBinary: string;
  private readonly tmpRoot: string;
  private readonly workingDirectory: string;

  private reservedPorts: number[] = [];
  private suiProcess?: ChildProcess;
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
    this.suiBinary = options.suiBinary ?? 'sui';
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
    };

    const startArgs = [
      'start',
      '--with-faucet',
      '--force-regenesis',
      '--rpc-port',
      String(rpcPort),
      '--faucet-port',
      String(faucetPort),
    ];

    const suiProcess = spawn(this.suiBinary, startArgs, {
      cwd: this.workingDirectory,
      env: this.suiEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!suiProcess.pid) {
      throw new Error('Failed to start local Sui process.');
    }

    this.suiProcess = suiProcess;
    this.processTracker.track(suiProcess.pid, 'sui-localnet');

    await this.waitForRpcReady();

    const publishOutput = await this.runSuiCommand(
      ['client', 'publish', this.contractsPath, '--gas-budget', '100000000', '--json'],
      CONTRACT_DEPLOY_TIMEOUT,
    );

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
      await this.portAllocator.release(this.reservedPorts);
      this.reservedPorts = [];

      if (this.tmpDir) {
        await rm(this.tmpDir, { recursive: true, force: true });
      }

      this.suiProcess = undefined;
      this.suiEnvironment = undefined;
      this.tmpDir = undefined;
      this._client = undefined;
      this._contractAddresses = undefined;
      this._faucetUrl = undefined;
      this._rpcUrl = undefined;
    }
  }

  private async waitForRpcReady(timeoutMs = SUI_STARTUP_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
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
          // Try the next known faucet endpoint shape.
        }
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchFirst(value: string, expression: RegExp): string | undefined {
  return expression.exec(value)?.[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
