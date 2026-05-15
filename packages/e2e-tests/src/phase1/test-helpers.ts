import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FilesystemBlobStore, MeshSuiClient, SqliteCursorStore, TaskClient } from '@agentic-mesh/core';
import { PaymentRail, TaskStatus, type Capability, type NetworkConfig, type Task } from '@agentic-mesh/types';
import type { SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { EVENT_TIMEOUT, type SuiTestNetwork } from '../harness/index.js';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export const defaultPriceMist = 100_000_000n;
export const defaultDisputeWindowMs = 3_600_000;
export const defaultExpiryHours = 1;
export const pollIntervalMs = 250;

export function createNetworkConfig(network: SuiTestNetwork): NetworkConfig {
  return {
    rpcUrl: network.rpcUrl,
    faucetUrl: network.faucetUrl,
    packageId: network.contractAddresses.packageId,
    registryId: network.contractAddresses.registryId,
  };
}

export async function createArtifactRoot(name: string): Promise<string> {
  const root = join(process.cwd(), '.artifacts', `${name}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

export async function createArtifactDir(root: string, name: string): Promise<string> {
  const dir = join(root, `${name}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function createCapability(params: {
  name: string;
  description?: string;
  version?: string;
  amountMist?: bigint;
  currency?: string;
}): Capability {
  return {
    name: params.name,
    description: params.description ?? `${params.name} capability`,
    version: params.version ?? '1.0.0',
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: params.amountMist ?? defaultPriceMist,
      currency: params.currency ?? 'MIST',
    },
  };
}

export function createTestDid(name: string): `did:mesh:${string}` {
  return `did:mesh:${name}-${randomUUID()}`;
}

export function buildEchoResult(taskId: string, capability: string, inputData: Uint8Array): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      echo: decodeInput(inputData),
      taskId,
      capability,
      timestamp: Date.now(),
      inputHash: createHash('sha256').update(inputData).digest('hex'),
    }),
  );
}

export async function postTaskWithBlobStore(params: {
  taskClient: TaskClient;
  blobStore: FilesystemBlobStore;
  input: string | Uint8Array;
  capability?: string;
  agreementHash?: string;
  priceMist?: bigint;
  disputeWindowMs?: number;
  expiryHours?: number;
  keypair: Ed25519Keypair;
}): Promise<{ taskId: string; inputBlobId: string; inputData: Uint8Array }> {
  const inputData = typeof params.input === 'string' ? encoder.encode(params.input) : params.input;
  const { blobId: inputBlobId } = await params.blobStore.store(inputData);
  const { taskId } = await params.taskClient.postTask({
    capability: params.capability ?? 'echo',
    category: 'general',
    inputBlobId,
    agreementHash: params.agreementHash,
    priceMist: params.priceMist ?? defaultPriceMist,
    disputeWindowMs: params.disputeWindowMs ?? defaultDisputeWindowMs,
    expiryHours: params.expiryHours ?? defaultExpiryHours,
    keypair: params.keypair,
  });

  return { taskId, inputBlobId, inputData };
}

export async function waitForTaskStatus(
  taskClient: TaskClient,
  taskId: string,
  status: TaskStatus,
  timeoutMs = EVENT_TIMEOUT,
): Promise<Task> {
  return waitForCondition(async () => {
    const task = await taskClient.getTask(taskId);
    return task?.status === status ? task : undefined;
  }, timeoutMs, `Task ${taskId} never reached status ${TaskStatus[status]}`);
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

    await delay(pollIntervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${failureMessage}: ${lastError.message}`);
  }

  throw new Error(failureMessage);
}

export async function fetchAllEvents(suiClient: MeshSuiClient, eventType: string): Promise<SuiEvent[]> {
  const events: SuiEvent[] = [];
  let cursor = null;

  do {
    const page = await suiClient.queryEvents(eventType, cursor, 100);
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) {
      break;
    }
  } while (cursor);

  return events;
}

export async function seedCursorToLatestEvent(
  suiClient: MeshSuiClient,
  eventType: string,
  cursorStore: SqliteCursorStore,
): Promise<void> {
  const existingCursor = await cursorStore.getCursor(eventType);
  if (existingCursor) {
    return;
  }

  const events = await fetchAllEvents(suiClient, eventType);
  const latestEvent = events.at(-1);
  if (latestEvent) {
    await cursorStore.setCursor(eventType, latestEvent.id);
  }
}

export async function requestFromFaucet(faucetUrl: string, address: string, amount: bigint = 1_000_000_000n): Promise<void> {
  const endpoints = [`${faucetUrl}/v1/gas`, `${faucetUrl}/gas`];
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
  const deadline = Date.now() + 30_000;

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
            signal: AbortSignal.timeout(10_000),
          });

          if (response.ok) {
            return;
          }
        } catch {
          // Keep trying until the faucet is ready.
        }
      }
    }

    await delay(500);
  }

  throw new Error(`Failed to fund test wallet ${address} from faucet at ${faucetUrl}.`);
}

export async function getTaskEscrowValue(suiClient: MeshSuiClient, taskId: string): Promise<bigint> {
  const rawTask = await suiClient.getObject<Record<string, unknown>>(taskId);
  const escrow = isRecord(rawTask.escrow) ? rawTask.escrow : undefined;
  return toBigInt(escrow?.value ?? 0);
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

export function decodeInput(inputData: Uint8Array): string {
  try {
    return strictDecoder.decode(inputData);
  } catch {
    return Buffer.from(inputData).toString('hex');
  }
}

export function parseJson<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    return BigInt(value);
  }

  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }

  return 0n;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
