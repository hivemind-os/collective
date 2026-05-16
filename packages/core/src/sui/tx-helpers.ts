import type { Capability } from '@hivemind-os/collective-types';
import { Transaction } from '@mysten/sui/transactions';

import { stringToBytes } from '../internal/parsing.js';

export const CLOCK_OBJECT_ID = '0x6';
const OBJECT_ID_PATTERN = /^0x([0-9a-f]+)$/i;
const MAX_OBJECT_ID_HEX_LENGTH = 64;
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

export interface SetEncryptionKeyParams {
  packageId: string;
  cardId: string;
  encryptionPublicKey: Uint8Array;
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
  category: string;
  inputBlobId: string;
  agreementHash?: string;
  priceMist: bigint;
  disputeWindowMs: number;
  expiryHours: number;
}

export interface PostMeteredTaskParams {
  packageId: string;
  capability: string;
  category: string;
  inputBlobId: string;
  agreementHash?: string;
  maxPriceMist: bigint;
  unitPriceMist: bigint;
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
  providerCardId?: string;
}

export interface CompleteMeteredTaskParams {
  packageId: string;
  taskId: string;
  resultBlobId: string;
  meteredUnits: number;
  verificationHash: string;
  providerCardId?: string;
}

export interface ReleasePaymentParams {
  packageId: string;
  taskId: string;
}

export interface ReleaseMeteredPaymentParams {
  packageId: string;
  taskId: string;
}

export interface ClaimPaymentParams {
  packageId: string;
  taskId: string;
  providerCardId?: string;
}

export interface CancelTaskParams {
  packageId: string;
  taskId: string;
}

export interface RefundExpiredTaskParams {
  packageId: string;
  taskId: string;
}

export interface PlaceBidParams {
  packageId: string;
  taskId: string;
  bidPriceMist: bigint;
  reputationScore: bigint;
  evidenceBlob?: string;
}

export interface AcceptBidParams {
  packageId: string;
  taskId: string;
  bidId: string;
  otherBidIds?: string[];
}

export interface WithdrawBidParams {
  packageId: string;
  bidId: string;
}

export interface RejectBidParams {
  packageId: string;
  taskId: string;
  bidId: string;
}

export interface OpenDisputeParams {
  packageId: string;
  taskId: string;
  evidenceBlobId: string;
  proposedSplitMist: bigint;
  arbitratorAddress?: string;
}

export interface RespondToDisputeParams {
  packageId: string;
  disputeId: string;
  evidenceBlobId: string;
  proposedSplitMist: bigint;
}

export interface AcceptResolutionParams {
  packageId: string;
  disputeId: string;
  taskId: string;
}

export interface ArbitrateDisputeParams {
  packageId: string;
  disputeId: string;
  taskId: string;
  rulingSplitMist: bigint;
}

export interface PublishReputationAnchorParams {
  packageId: string;
  merkleRoot: number[];
  eventCount: number;
  blobId: string;
  fromTimestamp: number;
  toTimestamp: number;
}

export interface DepositStakeParams {
  packageId: string;
  amountMist: bigint;
  stakeType: 'agent' | 'relay';
}

export interface AddStakeParams {
  packageId: string;
  stakeId: string;
  amountMist: bigint;
}

export interface StartDeactivationParams {
  packageId: string;
  stakeId: string;
}

export interface WithdrawStakeParams {
  packageId: string;
  stakeId: string;
}

export interface SlashStakeParams {
  packageId: string;
  stakeId: string;
  taskId: string;
}

export interface RegisterRelayParams {
  packageId: string;
  endpoint: string;
  stakeId: string;
  capabilities: string[];
  region: string;
  routingFeeBps: number;
}

export interface RelayMutationParams {
  packageId: string;
  relayId: string;
}

export interface RecordRelayRoutingParams extends RelayMutationParams {
  feeAmountMist: bigint;
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

export function buildSetEncryptionKeyTx(params: SetEncryptionKeyParams): Transaction {
  validateSetEncryptionKeyParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::registry::set_encryption_key`,
    arguments: [
      tx.object(params.cardId),
      tx.pure.vector('u8', [...params.encryptionPublicKey]),
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
    target: `${params.packageId}::task::post_open_task`,
    arguments: [
      tx.pure.string(params.capability),
      tx.pure.string(params.category),
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

export function buildPostMeteredTaskTx(params: PostMeteredTaskParams): Transaction {
  validatePostMeteredTaskParams(params);

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.maxPriceMist)]);

  tx.moveCall({
    target: `${params.packageId}::task::post_metered_task`,
    arguments: [
      tx.pure.string(params.capability),
      tx.pure.vector('u8', [...stringToBytes(params.inputBlobId)]),
      tx.pure.vector('u8', [...stringToBytes(params.agreementHash ?? '')]),
      paymentCoin,
      tx.pure.u64(params.unitPriceMist),
      tx.pure.u64(params.disputeWindowMs),
      tx.pure.u64(params.expiryHours),
      tx.pure.string(params.category),
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
    target: `${params.packageId}::task::${params.providerCardId ? 'complete_task_with_card' : 'complete_task'}`,
    arguments: params.providerCardId
      ? [
          tx.object(params.taskId),
          tx.object(params.providerCardId),
          tx.pure.vector('u8', [...stringToBytes(params.resultBlobId)]),
          tx.object(CLOCK_OBJECT_ID),
        ]
      : [
          tx.object(params.taskId),
          tx.pure.vector('u8', [...stringToBytes(params.resultBlobId)]),
          tx.object(CLOCK_OBJECT_ID),
        ],
  });

  return tx;
}

export function buildCompleteMeteredTaskTx(params: CompleteMeteredTaskParams): Transaction {
  validateMeteredTaskCompletionParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::${params.providerCardId ? 'complete_metered_task_with_card' : 'complete_metered_task'}`,
    arguments: params.providerCardId
      ? [
          tx.object(params.taskId),
          tx.object(params.providerCardId),
          tx.pure.u64(params.meteredUnits),
          tx.pure.vector('u8', [...stringToBytes(params.resultBlobId)]),
          tx.pure.vector('u8', [...hexToBytes(params.verificationHash)]),
          tx.object(CLOCK_OBJECT_ID),
        ]
      : [
          tx.object(params.taskId),
          tx.pure.u64(params.meteredUnits),
          tx.pure.vector('u8', [...stringToBytes(params.resultBlobId)]),
          tx.pure.vector('u8', [...hexToBytes(params.verificationHash)]),
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

export function buildReleaseMeteredPaymentTx(params: ReleaseMeteredPaymentParams): Transaction {
  validateTaskMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::release_metered_payment`,
    arguments: [tx.object(params.taskId)],
  });

  return tx;
}

export function buildClaimPaymentTx(params: ClaimPaymentParams): Transaction {
  validateClaimPaymentParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::task::${params.providerCardId ? 'claim_payment_with_card' : 'claim_payment'}`,
    arguments: params.providerCardId
      ? [tx.object(params.taskId), tx.object(params.providerCardId), tx.object(CLOCK_OBJECT_ID)]
      : [tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
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

export function buildPlaceBidTx(params: PlaceBidParams): Transaction {
  validatePlaceBidParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::marketplace::place_bid`,
    arguments: [
      tx.object(params.taskId),
      tx.pure.u64(params.reputationScore),
      tx.pure.u64(params.bidPriceMist),
      tx.pure.vector('u8', [...stringToBytes(params.evidenceBlob ?? '')]),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildAcceptBidTx(params: AcceptBidParams): Transaction {
  validateAcceptBidParams(params);

  const tx = new Transaction();
  for (const bidId of params.otherBidIds ?? []) {
    tx.moveCall({
      target: `${params.packageId}::marketplace::reject_bid`,
      arguments: [tx.object(bidId), tx.object(params.taskId)],
    });
  }

  tx.moveCall({
    target: `${params.packageId}::marketplace::accept_bid`,
    arguments: [tx.object(params.taskId), tx.object(params.bidId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

export function buildWithdrawBidTx(params: WithdrawBidParams): Transaction {
  validateWithdrawBidParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::marketplace::withdraw_bid`,
    arguments: [tx.object(params.bidId)],
  });

  return tx;
}

export function buildRejectBidTx(params: RejectBidParams): Transaction {
  validateRejectBidParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::marketplace::reject_bid`,
    arguments: [tx.object(params.bidId), tx.object(params.taskId)],
  });

  return tx;
}

export function buildOpenDisputeTx(params: OpenDisputeParams): Transaction {
  validateOpenDisputeParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::dispute::open_dispute`,
    arguments: [
      tx.object(params.taskId),
      tx.pure.vector('u8', [...stringToBytes(params.evidenceBlobId)]),
      tx.pure.u64(params.proposedSplitMist),
      tx.pure.address(params.arbitratorAddress ?? '0x0'),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildRespondToDisputeTx(params: RespondToDisputeParams): Transaction {
  validateRespondToDisputeParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::dispute::respond_to_dispute`,
    arguments: [
      tx.object(params.disputeId),
      tx.pure.vector('u8', [...stringToBytes(params.evidenceBlobId)]),
      tx.pure.u64(params.proposedSplitMist),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildAcceptResolutionTx(params: AcceptResolutionParams): Transaction {
  validateAcceptResolutionParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::dispute::accept_resolution`,
    arguments: [tx.object(params.disputeId), tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });

  return tx;
}

export function buildArbitrateDisputeTx(params: ArbitrateDisputeParams): Transaction {
  validateArbitrateDisputeParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::dispute::arbitrate`,
    arguments: [
      tx.object(params.disputeId),
      tx.object(params.taskId),
      tx.pure.u64(params.rulingSplitMist),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildPublishReputationAnchorTx(params: PublishReputationAnchorParams): Transaction {
  validatePublishReputationAnchorParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::reputation::publish_anchor`,
    arguments: [
      tx.pure.vector('u8', params.merkleRoot),
      tx.pure.u64(params.eventCount),
      tx.pure.vector('u8', [...stringToBytes(params.blobId)]),
      tx.pure.u64(params.fromTimestamp),
      tx.pure.u64(params.toTimestamp),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildDepositStakeTx(params: DepositStakeParams): Transaction {
  validateDepositStakeParams(params);

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.amountMist)]);
  tx.moveCall({
    target: `${params.packageId}::staking::deposit_stake`,
    arguments: [paymentCoin, tx.pure.u8(stakeTypeToMoveValue(params.stakeType)), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildAddStakeTx(params: AddStakeParams): Transaction {
  validateAddStakeParams(params);

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.amountMist)]);
  tx.moveCall({
    target: `${params.packageId}::staking::add_stake`,
    arguments: [tx.object(params.stakeId), paymentCoin],
  });
  return tx;
}

export function buildStartDeactivationTx(params: StartDeactivationParams): Transaction {
  validateStakeMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::staking::start_deactivation`,
    arguments: [tx.object(params.stakeId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildWithdrawStakeTx(params: WithdrawStakeParams): Transaction {
  validateStakeMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::staking::withdraw_stake`,
    arguments: [tx.object(params.stakeId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildSlashExpiredEscrowTx(params: SlashStakeParams): Transaction {
  validateSlashStakeParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::staking::slash_expired_escrow`,
    arguments: [tx.object(params.stakeId), tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildSlashNonDeliveryTx(params: SlashStakeParams): Transaction {
  validateSlashStakeParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::staking::slash_non_delivery`,
    arguments: [tx.object(params.stakeId), tx.object(params.taskId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildRegisterRelayTx(params: RegisterRelayParams): Transaction {
  validateRegisterRelayParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::relay_registry::register_relay`,
    arguments: [
      tx.pure.string(params.endpoint),
      tx.object(params.stakeId),
      tx.pure.vector('string', params.capabilities),
      tx.pure.string(params.region),
      tx.pure.u64(params.routingFeeBps),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildHeartbeatRelayTx(params: RelayMutationParams): Transaction {
  validateRelayMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::relay_registry::heartbeat`,
    arguments: [tx.object(params.relayId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildDeactivateRelayTx(params: RelayMutationParams): Transaction {
  validateRelayMutationParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::relay_registry::deactivate_relay`,
    arguments: [tx.object(params.relayId)],
  });
  return tx;
}

export function buildRecordRelayRoutingTx(params: RecordRelayRoutingParams): Transaction {
  validateRecordRelayRoutingParams(params);

  const tx = new Transaction();
  tx.moveCall({
    target: `${params.packageId}::relay_registry::record_routing`,
    arguments: [tx.object(params.relayId), tx.pure.u64(params.feeAmountMist)],
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

function validateSetEncryptionKeyParams(params: SetEncryptionKeyParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.cardId, 'cardId');
  assertEncryptionPublicKey(params.encryptionPublicKey, 'encryptionPublicKey');
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
  assertNonEmptyString(params.category, 'category');
  assertNonEmptyString(params.inputBlobId, 'inputBlobId');
  assertOptionalString(params.agreementHash, 'agreementHash');
  assertU64(params.priceMist, 'priceMist');
  assertSafeNonNegativeInteger(params.disputeWindowMs, 'disputeWindowMs');
  assertSafeNonNegativeInteger(params.expiryHours, 'expiryHours');
}

function validatePostMeteredTaskParams(params: PostMeteredTaskParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertNonEmptyString(params.capability, 'capability');
  assertNonEmptyString(params.category, 'category');
  assertNonEmptyString(params.inputBlobId, 'inputBlobId');
  assertOptionalString(params.agreementHash, 'agreementHash');
  assertU64(params.maxPriceMist, 'maxPriceMist');
  assertU64(params.unitPriceMist, 'unitPriceMist');
  assertSafeNonNegativeInteger(params.disputeWindowMs, 'disputeWindowMs');
  assertSafeNonNegativeInteger(params.expiryHours, 'expiryHours');
}

function validateTaskMutationParams(params: { packageId: string; taskId: string }): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.taskId, 'taskId');
}

function validatePlaceBidParams(params: PlaceBidParams): void {
  validateTaskMutationParams(params);
  assertU64(params.bidPriceMist, 'bidPriceMist');
  assertU64(params.reputationScore, 'reputationScore');
  assertOptionalString(params.evidenceBlob, 'evidenceBlob');
}

function validateAcceptBidParams(params: AcceptBidParams): void {
  validateTaskMutationParams(params);
  assertObjectId(params.bidId, 'bidId');
  params.otherBidIds?.forEach((bidId, index) => assertObjectId(bidId, `otherBidIds[${index}]`));
}

function validateWithdrawBidParams(params: WithdrawBidParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.bidId, 'bidId');
}

function validateRejectBidParams(params: RejectBidParams): void {
  validateTaskMutationParams(params);
  assertObjectId(params.bidId, 'bidId');
}

function validateTaskCompletionParams(params: CompleteTaskParams): void {
  validateTaskMutationParams(params);
  assertOptionalObjectId(params.providerCardId, 'providerCardId');
  assertNonEmptyString(params.resultBlobId, 'resultBlobId');
}

function validateMeteredTaskCompletionParams(params: CompleteMeteredTaskParams): void {
  validateTaskMutationParams(params);
  assertOptionalObjectId(params.providerCardId, 'providerCardId');
  assertNonEmptyString(params.resultBlobId, 'resultBlobId');
  assertSafeNonNegativeInteger(params.meteredUnits, 'meteredUnits');
  assertHexString(params.verificationHash, 'verificationHash');
}

function validateClaimPaymentParams(params: ClaimPaymentParams): void {
  validateTaskMutationParams(params);
  assertOptionalObjectId(params.providerCardId, 'providerCardId');
}

function validateOpenDisputeParams(params: OpenDisputeParams): void {
  validateTaskMutationParams(params);
  assertNonEmptyString(params.evidenceBlobId, 'evidenceBlobId');
  assertU64(params.proposedSplitMist, 'proposedSplitMist');
  assertOptionalObjectId(params.arbitratorAddress, 'arbitratorAddress');
}

function validateRespondToDisputeParams(params: RespondToDisputeParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.disputeId, 'disputeId');
  assertNonEmptyString(params.evidenceBlobId, 'evidenceBlobId');
  assertU64(params.proposedSplitMist, 'proposedSplitMist');
}

function validateAcceptResolutionParams(params: AcceptResolutionParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.disputeId, 'disputeId');
  assertObjectId(params.taskId, 'taskId');
}

function validateArbitrateDisputeParams(params: ArbitrateDisputeParams): void {
  validateAcceptResolutionParams(params);
  assertU64(params.rulingSplitMist, 'rulingSplitMist');
}

function validatePublishReputationAnchorParams(params: PublishReputationAnchorParams): void {
  assertObjectId(params.packageId, 'packageId');
  if (params.merkleRoot.length === 0) {
    throw new Error('merkleRoot must not be empty.');
  }
  assertSafeNonNegativeInteger(params.eventCount, 'eventCount');
  assertNonEmptyString(params.blobId, 'blobId');
  assertSafeNonNegativeInteger(params.fromTimestamp, 'fromTimestamp');
  assertSafeNonNegativeInteger(params.toTimestamp, 'toTimestamp');
}

function validateDepositStakeParams(params: DepositStakeParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertU64(params.amountMist, 'amountMist');
  assertStakeType(params.stakeType, 'stakeType');
}

function validateAddStakeParams(params: AddStakeParams): void {
  validateStakeMutationParams(params);
  assertU64(params.amountMist, 'amountMist');
}

function validateStakeMutationParams(params: { packageId: string; stakeId: string }): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.stakeId, 'stakeId');
}

function validateSlashStakeParams(params: SlashStakeParams): void {
  validateStakeMutationParams(params);
  assertObjectId(params.taskId, 'taskId');
}

function validateRegisterRelayParams(params: RegisterRelayParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.stakeId, 'stakeId');
  assertNonEmptyString(params.endpoint, 'endpoint');
  assertNonEmptyString(params.region, 'region');
  params.capabilities.forEach((capability, index) => assertNonEmptyString(capability, `capabilities[${index}]`));
  assertSafeNonNegativeInteger(params.routingFeeBps, 'routingFeeBps');
  if (params.routingFeeBps > 10_000) {
    throw new Error('routingFeeBps must be less than or equal to 10000.');
  }
}

function validateRelayMutationParams(params: RelayMutationParams): void {
  assertObjectId(params.packageId, 'packageId');
  assertObjectId(params.relayId, 'relayId');
}

function validateRecordRelayRoutingParams(params: RecordRelayRoutingParams): void {
  validateRelayMutationParams(params);
  assertU64(params.feeAmountMist, 'feeAmountMist');
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

function assertEncryptionPublicKey(value: Uint8Array, field: string): void {
  if (value.length !== 0 && value.length !== 32) {
    throw new Error(`${field} must be either empty or 32 bytes.`);
  }
}

function assertObjectId(value: string, field: string): void {
  const trimmed = value.trim();
  const match = OBJECT_ID_PATTERN.exec(trimmed);
  const hex = match?.[1];

  if (hex === undefined || hex.length > MAX_OBJECT_ID_HEX_LENGTH || /^0+$/i.test(hex)) {
    throw new Error(`${field} must be a 0x-prefixed hex object id.`);
  }
}

function assertOptionalObjectId(value: string | undefined, field: string): void {
  if (value !== undefined) {
    assertObjectId(value, field);
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

function assertHexString(value: string, field: string): void {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error(`${field} must be an even-length hex string.`);
  }
}

function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
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

function assertStakeType(value: string, field: string): void {
  if (value !== 'agent' && value !== 'relay') {
    throw new Error(`${field} must be either "agent" or "relay".`);
  }
}

function stakeTypeToMoveValue(value: 'agent' | 'relay'): 0 | 1 {
  return value === 'relay' ? 1 : 0;
}
