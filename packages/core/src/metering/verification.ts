import type { HashChainProof, Task } from '@agentic-mesh/types';

import { DEFAULT_METERING_CHUNK_SIZE, HashChain, createMeteringSeed, splitIntoMeteringUnits } from './hash-chain.js';

const decoder = new TextDecoder();
const METERED_RESULT_SCHEMA = 'agentic-mesh-metered-result/v1';
const BASE64_RESULT_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface MeteredResultEnvelope {
  schema: typeof METERED_RESULT_SCHEMA;
  resultEncoding: 'base64';
  result: string;
  proof: HashChainProof;
  unitChunkSize: number;
}

export class ResultVerifier {
  verify(task: Pick<Task, 'id' | 'verificationHash'>, proof: HashChainProof, expectedData: Uint8Array[]): boolean {
    if (!task.verificationHash) {
      return false;
    }

    return HashChain.verifyChain(proof, expectedData, createMeteringSeed(task.id))
      && task.verificationHash.toLowerCase() === proof.root.toLowerCase();
  }
}

export function createMeteredResultEnvelope(
  resultData: Uint8Array,
  proof: HashChainProof,
  unitChunkSize = DEFAULT_METERING_CHUNK_SIZE,
): MeteredResultEnvelope {
  if (!Number.isSafeInteger(unitChunkSize) || unitChunkSize <= 0) {
    throw new Error('unitChunkSize must be a positive safe integer.');
  }

  return {
    schema: METERED_RESULT_SCHEMA,
    resultEncoding: 'base64',
    result: Buffer.from(resultData).toString('base64'),
    proof,
    unitChunkSize,
  };
}

export function serializeMeteredResultEnvelope(envelope: MeteredResultEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function parseMeteredResultEnvelope(data: Uint8Array): MeteredResultEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(data)) as unknown;
  } catch {
    return null;
  }

  if (!isMeteredResultEnvelope(parsed)) {
    return null;
  }

  return parsed;
}

export function decodeMeteredResult(envelope: MeteredResultEnvelope): Uint8Array {
  return new Uint8Array(Buffer.from(envelope.result, 'base64'));
}

export function getMeteredResultUnits(envelope: MeteredResultEnvelope): Uint8Array[] {
  return splitIntoMeteringUnits(decodeMeteredResult(envelope), envelope.unitChunkSize);
}

function isMeteredResultEnvelope(value: unknown): value is MeteredResultEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const unitChunkSize = candidate.unitChunkSize;
  return candidate.schema === METERED_RESULT_SCHEMA
    && candidate.resultEncoding === 'base64'
    && typeof candidate.result === 'string'
    && BASE64_RESULT_PATTERN.test(candidate.result)
    && typeof unitChunkSize === 'number'
    && Number.isSafeInteger(unitChunkSize)
    && unitChunkSize > 0
    && isHashChainProof(candidate.proof);
}

function isHashChainProof(value: unknown): value is HashChainProof {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const unitCount = candidate.unitCount;
  return typeof candidate.root === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.root)
    && Array.isArray(candidate.intermediateHashes)
    && candidate.intermediateHashes.every((entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/i.test(entry))
    && typeof unitCount === 'number'
    && Number.isSafeInteger(unitCount)
    && unitCount >= 0;
}
