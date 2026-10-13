/**
 * Verified payout evidence for RevRule entitlement ledger lines.
 *
 * RevRule remains non-custodial: a regulated payout partner sends the transfer
 * and a trusted caller independently verifies a successful, sufficiently
 * confirmed ERC-20 Transfer log against a chain RPC. This module cannot pay.
 *
 * The original ENTITLEMENT is immutable. The verified transfer is appended as
 * a separate hash-chained PAYOUT_SETTLED record joined by instructionId,
 * eventId, graphId, ruleId and participantId. A tx hash alone is insufficient:
 * logIndex distinguishes separate payouts in a batched transaction.
 */
import type {
  Distribution,
  Ledger,
  LedgerEntry,
  PayoutOnchainEvidence,
} from './types.js';

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const UINT = /^(0|[1-9][0-9]*)$/;

export interface TransferLocator {
  chainId: number;
  txHash: string;
  logIndex: number;
}

/** Result from a trusted receipt/log verifier, NOT untrusted user input. */
export interface VerifiedErc20Transfer extends TransferLocator {
  blockHash: string;
  blockNumber: number;
  tokenAddress: string;
  recipientAddress: string;
  senderAddress: string;
  amountBaseUnits: string;
  confirmations: number;
  /** Must be confirmed by checking the transaction receipt, not presumed. */
  transactionSucceeded: boolean;
}

export interface PayoutVerificationOptions {
  expectedChainId: number;
  expectedTokenAddress: string;
  /** Payout executor / treasury address authorized for this instruction. */
  expectedSenderAddress: string;
  /** ERC-20 decimals independently established from trusted token config. */
  tokenDecimals: number;
  minConfirmations?: number;
  verifiedBy: string;
  /**
   * Trusted adapter must retrieve a canonical receipt and validate its
   * success, ERC-20 Transfer topic, actual logIndex, block, confirmations,
   * and finality policy. Must NOT accept user-supplied proof without RPC checks.
   */
  verifyTransfer(locator: TransferLocator): Promise<VerifiedErc20Transfer | null>;
}

function safeInt(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(label + ' must be a safe integer >= ' + minimum);
  }
}

function address(value: string, label: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new Error(label + ' must be an EVM address');
  }
  return value.toLowerCase();
}

function txHash(value: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error('txHash must be a 32-byte EVM transaction hash');
  }
  return value.toLowerCase();
}

function existingPayouts(ledger: Ledger): LedgerEntry[] {
  return ledger.entries().filter((entry) => entry.type === 'PAYOUT_SETTLED');
}

/**
 * Append a verified settlement without rewriting the entitlement or
 * generating a new revenue event. Supports a single *full* ERC-20 payout per
 * instruction in v1; partials and non-EVM rails require separate designs.
 *
 * IMPORTANT: verifyTransfer must be backed by an independent chain receipt
 * verifier. This library does not contain a live RPC client or claim that a
 * transaction settled based merely on a submitted hash.
 */
export async function recordVerifiedOnchainPayout(
  ledger: Ledger,
  distribution: Distribution,
  locator: TransferLocator,
  options: PayoutVerificationOptions,
): Promise<LedgerEntry> {
  if (distribution.rail !== 'x402' && distribution.rail !== 'stablecoin') {
    throw new Error('on-chain payout evidence requires x402 or stablecoin rail');
  }
  if (distribution.destination.rail !== 'x402' && distribution.destination.rail !== 'stablecoin') {
    throw new Error('payout destination must use an on-chain rail');
  }
  safeInt(distribution.amountMicros, 'distribution.amountMicros', 1);
  safeInt(locator.chainId, 'locator.chainId', 1);
  safeInt(locator.logIndex, 'locator.logIndex');
  safeInt(options.expectedChainId, 'expectedChainId', 1);
  safeInt(options.tokenDecimals, 'tokenDecimals');
  if (options.tokenDecimals > 36) throw new Error('tokenDecimals exceeds supported bound');
  // A conservative default; production must set chain-appropriate finality policy.
  const confirmations = options.minConfirmations ?? 12;
  safeInt(confirmations, 'minConfirmations', 1);
  if (!options.verifiedBy || options.verifiedBy.trim().length > 128) {
    throw new Error('verifiedBy must name a trusted verifier (max 128 chars)');
  }
  const hash = txHash(locator.txHash);
  const expectedToken = address(options.expectedTokenAddress, 'expectedTokenAddress');
  const recipient = address(distribution.destination.address, 'distribution destination');
  const sender = address(options.expectedSenderAddress, 'expectedSenderAddress');
  if (locator.chainId !== options.expectedChainId) {
    throw new Error('transfer chain does not match configured payout chain');
  }
  if (!ledger.verifyChain()) throw new Error('entitlement ledger hash chain is invalid');

  const entitlement = ledger.entries().find((entry) =>
    entry.type === 'ENTITLEMENT' &&
    entry.graphId === distribution.graphId &&
    entry.eventId === distribution.eventId &&
    entry.participantId === distribution.participantId &&
    entry.ruleId !== undefined &&
    'dist:' + entry.eventId + ':' + entry.ruleId + ':' + entry.participantId === distribution.instructionId &&
    entry.amountMicros === distribution.amountMicros
  );
  if (!entitlement || entitlement.ruleId === undefined ||
      entitlement.participantId === undefined || entitlement.amountMicros === undefined) {
    throw new Error('matching entitlement line for payout instruction not found');
  }

  // Always run a trusted receipt verification before recording new evidence.
  const proof = await options.verifyTransfer({chainId:locator.chainId, txHash:hash, logIndex:locator.logIndex});
  if (!proof || !proof.transactionSucceeded) throw new Error('transfer is not independently verified as successful');
  safeInt(proof.chainId, 'verified chainId', 1);
  safeInt(proof.logIndex, 'verified logIndex');
  safeInt(proof.blockNumber, 'verified blockNumber', 1);
  safeInt(proof.confirmations, 'verified confirmations');
  const canonicalTx = txHash(proof.txHash);
  const blockHash = txHash(proof.blockHash);
  if (proof.chainId !== locator.chainId || canonicalTx !== hash || proof.logIndex !== locator.logIndex) {
    throw new Error('verified receipt does not match requested transfer locator');
  }
  if (proof.confirmations < confirmations) throw new Error('payout transfer has insufficient confirmations');
  if (address(proof.tokenAddress, 'verified token') !== expectedToken) {
    throw new Error('verified token is not the configured payout token');
  }
  if (address(proof.senderAddress, 'verified sender') !== sender) {
    throw new Error('verified transfer sender is not the approved payout executor');
  }
  if (address(proof.recipientAddress, 'verified recipient') !== recipient) {
    throw new Error('verified transfer recipient does not match entitlement destination');
  }
  if (typeof proof.amountBaseUnits !== 'string' || proof.amountBaseUnits.length > 80 ||
      !UINT.test(proof.amountBaseUnits)) {
    throw new Error('verified transfer amount must be a nonnegative base-unit integer string');
  }
  // Exact BigInt comparison; no floats, no assumption that all tokens use 6 decimals.
  if (BigInt(proof.amountBaseUnits) * 1_000_000n !==
      BigInt(distribution.amountMicros) * (10n ** BigInt(options.tokenDecimals))) {
    throw new Error('verified transfer amount does not match entitlement amount');
  }
  if (!ledger.verifyChain()) throw new Error('ledger chain changed during verification');

  // Post-await duplicate checks prevent two concurrent verifications from
  // appending a claim against the same ERC-20 Transfer log.
  for (const old of existingPayouts(ledger)) {
    const evidence = old.payoutEvidence;
    if (!evidence) continue;
    if (evidence.instructionId === distribution.instructionId &&
        old.graphId === distribution.graphId) {
      if (evidence.chainId === proof.chainId &&
          evidence.txHash.toLowerCase() === hash &&
          evidence.logIndex === proof.logIndex) return old; // exact replay
      throw new Error('payout instruction already has different settlement evidence');
    }
    if (evidence.chainId === proof.chainId &&
        evidence.txHash.toLowerCase() === hash &&
        evidence.logIndex === proof.logIndex) {
      throw new Error('transfer log already attributed to another entitlement');
    }
  }

  const payoutEvidence: PayoutOnchainEvidence = {
    instructionId: distribution.instructionId,
    paymentKind: 'entitlement_payout',
    chainId: proof.chainId,
    txHash: canonicalTx,
    logIndex: proof.logIndex,
    blockHash,
    blockNumber: proof.blockNumber,
    tokenAddress: expectedToken,
    recipientAddress: recipient,
    senderAddress: sender,
    amountBaseUnits: proof.amountBaseUnits,
    confirmationsAtVerification: proof.confirmations,
    verifiedBy: options.verifiedBy.trim(),
  };
  return ledger.append({
    eventId: entitlement.eventId,
    graphId: entitlement.graphId,
    graphVersion: entitlement.graphVersion,
    ruleId: entitlement.ruleId,
    participantId: entitlement.participantId,
    type: 'PAYOUT_SETTLED',
    amountMicros: entitlement.amountMicros,
    reason: 'verified on-chain entitlement payout (not new agent spending)',
    payoutEvidence,
  });
}

/**
 * Entitlements with associated proven payout records side-by-side, without
 * modifying their original hash-chained entries or double-counting revenue.
 */
export function readEntitlementsWithPayouts(
  ledger: Ledger,
  filter: { graphId?: string; eventId?: string } = {},
): Array<{ entitlement: LedgerEntry; payouts: LedgerEntry[] }> {
  const entries = ledger.entries();
  return entries
    .filter((e) => e.type === 'ENTITLEMENT' &&
      (filter.graphId === undefined || e.graphId === filter.graphId) &&
      (filter.eventId === undefined || e.eventId === filter.eventId))
    .map((entitlement) => {
      const instructionId =
        'dist:' + entitlement.eventId + ':' + entitlement.ruleId + ':' + entitlement.participantId;
      const payouts = entries.filter((e) =>
        e.type === 'PAYOUT_SETTLED' &&
        e.graphId === entitlement.graphId &&
        e.eventId === entitlement.eventId &&
        e.ruleId === entitlement.ruleId &&
        e.participantId === entitlement.participantId &&
        e.payoutEvidence?.instructionId === instructionId
      );
      return { entitlement, payouts };
    });
}
