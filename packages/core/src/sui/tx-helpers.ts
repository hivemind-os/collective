import type { Capability } from '@agentic-mesh/types';
import { Transaction } from '@mysten/sui/transactions';

import { stringToBytes } from '../internal/parsing.js';

export const CLOCK_OBJECT_ID = '0x6';
const OBJECT_ID_PATTERN = /^0x[0-9a-f]+$/i;
const MAX_U64 = (1n << 64n) - 1n;

export interface RegisterAgentParams {
  packageId: string;
  registryId: string;
  name: string;
  did: string;
  description: string;
  capabilities: Capability[];
  endpoint: string;
}

export interface UpdateAgentParams {
  packageId: string;
  registryId: string;
  cardId: string;
  name: string;
  description: string;
  endpoint: string;
}

export interface UpdateCapabilitiesParams {
  packageId: string;
  registryId: string;
  cardId: string;
  capabilities: Capability[];
}

export interface DeactivateAgentParams {
  packageId: string;
  registryId: string;
  cardId: string;
}

export interface ReactivateAgentParams {
  packageId: string;
  registryId: string;
  cardId: string;
}

export interface PostTaskParams {
  packageId: string;
  capability: string;
  inputBlobId: string;
  agreementHash?: string;
  priceMist: bigint;
  disputeWindowMs: number;
  expiryHours: number;
}

export interface AcceptTaskParams {
  packageId: string;
  taskId: string;
}

export interface CompleteTaskParams {
  packageId: string;
  taskId: string;
  resultBlobId: string;
}

export interface ReleasePaymentParams {
  packageId: string;
  taskId: string;
}

export interface ClaimPaymentParams {
  packageId: string;
  taskId: string;
}

export interface CancelTaskParams {
  packageId: string;
  taskId: string;
}

export interface RefundExpiredTaskParams {
  packageId: string;
  taskId: string;
}

export function buildRegisterAgentTx(params: RegisterAgentParams): Transaction {
  validateRegisterAgentParams(params);

  const tx = new Transaction();
  const capabilityVectors = toCapabilityVectors(params.capabilities);

  tx.moveCall({
    target: `${params.packageId}::registry::register_agent`,
    arguments: [
      tx.object(params.registryId),
      tx.pure.string(params.name),
      tx.pure.string(params.did),
      tx.pure.string(params.description),
      tx.pure.vector('string', capabilityVectors.names),
      tx.pure.vector('string', capabilityVectors.descriptions),
      tx.pure.vector('string', capabilityVectors.versions),
      tx.pure.vector('u64', capabilityVectors.prices),
      tx.pure.vector('string', capabilityVectors.currencies),
      tx.pure.string(params.endpoint),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildUpdateAgentTx(params: UpdateAgentParams): Transaction {
  validateUpdateAgentParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::registry::update_agent`,
    arguments: [
      tx.object(params.registryId),
      tx.object(params.cardId),
      tx.pure.string(params.name),
      tx.pure.string(params.description),
      tx.pure.string(params.endpoint),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildUpdateCapabilitiesTx(params: UpdateCapabilitiesParams): Transaction {
  validateUpdateCapabilitiesParams(params);

  const tx = new Transaction();
  const capabilityVectors = toCapabilityVectors(params.capabilities);

  tx.moveCall({
    target: `${params.packageId}::registry::update_capabilities`,
    arguments: [
      tx.object(params.registryId),
      tx.object(params.cardId),
      tx.pure.vector('string', capabilityVectors.names),
      tx.pure.vector('string', capabilityVectors.descriptions),
      tx.pure.vector('string', capabilityVectors.versions),
      tx.pure.vector('u64', capabilityVectors.prices),
      tx.pure.vector('string', capabilityVectors.currencies),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildDeactivateAgentTx(params: DeactivateAgentParams): Transaction {
  validateAgentCardMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::registry::deactivate_agent`,
    arguments: [tx.object(params.registryId), tx.object(params.cardId)],
  });

  return tx;
}

export function buildReactivateAgentTx(params: ReactivateAgentParams): Transaction {
  validateAgentCardMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::registry::reactivate_agent`,
    arguments: [tx.object(params.registryId), tx.object(params.cardId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

export function buildPostTaskTx(params: PostTaskParams): Transaction {
  validatePostTaskParams(params);

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.priceMist)]);

  tx.moveCall({
    target: `${params.packageId}::task::post_task`,
    arguments: [
      tx.pure.string(params.capability),
      tx.pure.vector('u8', [...stringToBytes(params.inputBlobId)]),
      tx.pure.vector('u8', [...stringToBytes(params.agreementHash ?? '')]),
      paymentCoin,
      tx.pure.u64(params.disputeWindowMs),
      tx.pure.u64(params.expiryHours),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildAcceptTaskTx(params: AcceptTaskParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::accept_task`,
    arguments: [tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

export function buildCompleteTaskTx(params: CompleteTaskParams): Transaction {
  validateTaskCompletionParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::complete_task`,
    arguments: [
      tx.object(params.taskId),
      tx.pure.vector('u8', [...stringToBytes(params.resultBlobId)]),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildReleasePaymentTx(params: ReleasePaymentParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::release_payment`,
    arguments: [tx.object(params.taskId)],
  });

  return tx;
}

export function buildClaimPaymentTx(params: ClaimPaymentParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::claim_payment`,
    arguments: [tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

export function buildCancelTaskTx(params: CancelTaskParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::cancel_task`,
    arguments: [tx.object(params.taskId)],
  });

  return tx;
}

export function buildRefundExpiredTaskTx(params: RefundExpiredTaskParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::refund_expired_task`,
    arguments: [tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

function validateRegisterAgentParams(params: RegisterAgentParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.registryId, 'registryId');
  assertNonEmptyString(params.name, 'name');
  assertNonEmptyString(params.description, 'description');
  assertNonEmptyString(params.endpoint, 'endpoint');
  assertDid(params.did, 'did');
  assertCapabilities(params.capabilities);
}

function validateUpdateAgentParams(params: UpdateAgentParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.registryId, 'registryId');
  assertObjectId(params.cardId, 'cardId');
  assertNonEmptyString(params.name, 'name');
  assertNonEmptyString(params.description, 'description');
  assertNonEmptyString(params.endpoint, 'endpoint');
}

function validateUpdateCapabilitiesParams(params: UpdateCapabilitiesParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.registryId, 'registryId');
  assertObjectId(params.cardId, 'cardId');
  assertCapabilities(params.capabilities);
}

function validateAgentCardMutationParams(params: {
  packageId: string;
  registryId: string;
  cardId: string;
}): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.registryId, 'registryId');
  assertObjectId(params.cardId, 'cardId');
}

function validatePostTaskParams(params: PostTaskParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertNonEmptyString(params.capability, 'capability');
  assertNonEmptyString(params.inputBlobId, 'inputBlobId');
  assertOptionalString(params.agreementHash, 'agreementHash');
  assertU64(params.priceMist, 'priceMist');
  assertSafeNonNegativeInteger(params.disputeWindowMs, 'disputeWindowMs');
  assertSafeNonNegativeInteger(params.expiryHours, 'expiryHours');
}

function validateTaskMutationParams(params: { packageId: string; taskId: string }): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.taskId, 'taskId');
}

function validateTaskCompletionParams(params: CompleteTaskParams): void {
  validateTaskMutationParams(params);
  assertNonEmptyString(params.resultBlobId, 'resultBlobId');
}

function toCapabilityVectors(capabilities: Capability[]): {
  names: string[];
  descriptions: string[];
  versions: string[];
  prices: bigint[];
  currencies: string[];
} {
  return {
    names: capabilities.map((capability) => capability.name),
    descriptions: capabilities.map((capability) => capability.description),
    versions: capabilities.map((capability) => capability.version),
    prices: capabilities.map((capability) => capability.pricing.amount),
    currencies: capabilities.map((capability) => capability.pricing.currency),
  };
}

function assertCapabilities(capabilities: Capability[]): void {
  capabilities.forEach((capability, index) => {
    assertNonEmptyString(capability.name, `capabilities[${index}].name`);
    assertNonEmptyString(capability.description, `capabilities[${index}].description`);
    assertNonEmptyString(capability.version, `capabilities[${index}].version`);
    assertNonEmptyString(capability.pricing.currency, `capabilities[${index}].pricing.currency`);
    assertU64(capability.pricing.amount, `capabilities[${index}].pricing.amount`);
  });
}

function assertObjectId(value: string, field: string): void {
  if (!OBJECT_ID_PATTERN.test(value.trim())) {
    throw new Error(`${field} must be a 0x-prefixed hex object id.`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertOptionalString(value: string | undefined, field: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, field);
  }
}

function assertDid(value: string, field: string): void {
  if (!value.startsWith('did:mesh:') || value.trim().length <= 'did:mesh:'.length) {
    throw new Error(`${field} must be a did:mesh identifier.`);
  }
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

function assertU64(value: bigint | number, field: string): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer.`);
    }

    value = BigInt(value);
  }

  if (value < 0n || value > MAX_U64) {
    throw new Error(`${field} must fit in an unsigned 64-bit integer.`);
  }
}
