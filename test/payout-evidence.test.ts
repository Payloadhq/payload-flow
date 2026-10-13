import { describe, expect, it, vi, afterEach } from 'vitest';
import { InMemoryLedger } from '../src/ledger.js';
import { recordVerifiedOnchainPayout, readEntitlementsWithPayouts } from '../src/payout-evidence.js';
import { createEvmRpcTransferVerifier } from '../src/evm-receipt-verifier.js';
import type { Distribution } from '../src/types.js';
import type { PayoutVerificationOptions, VerifiedErc20Transfer } from '../src/payout-evidence.js';

const TX = '0x' + 'a'.repeat(64);
const BLOCK = '0x' + 'c'.repeat(64);
const TOKEN = '0x' + '1'.repeat(40);
const SENDER = '0x' + '2'.repeat(40);
const RECIPIENT = '0x' + '3'.repeat(40);
const OTHER = '0x' + '4'.repeat(40);

function fixture(rule = 'royalty', amountMicros = 1_000_000) {
  const ledger = new InMemoryLedger();
  ledger.append({
    eventId: 'event-1', graphId: 'revenue-graph', graphVersion: 2,
    type: 'ENTITLEMENT', ruleId: rule, participantId: 'developer',
    amountMicros, reason: 'developer royalty',
  });
  const distribution: Distribution = {
    instructionId: 'dist:event-1:' + rule + ':developer',
    graphId: 'revenue-graph', eventId: 'event-1', participantId: 'developer',
    destination: { rail: 'x402', address: RECIPIENT },
    amountMicros, currency: 'USDC', rail: 'x402', status: 'proposed',
  };
  const proof: VerifiedErc20Transfer = {
    chainId: 8453, txHash: TX, logIndex: 3, blockHash: BLOCK, blockNumber: 1234,
    tokenAddress: TOKEN, senderAddress: SENDER, recipientAddress: RECIPIENT,
    amountBaseUnits: String(amountMicros), confirmations: 24, transactionSucceeded: true,
  };
  const options: PayoutVerificationOptions = {
    expectedChainId: 8453, expectedTokenAddress: TOKEN,
    expectedSenderAddress: SENDER, tokenDecimals: 6, minConfirmations: 12,
    verifiedBy: 'trusted-payout-adapter', verifyTransfer: async () => proof,
  };
  const locator = { chainId: 8453, txHash: TX, logIndex: 3 };
  return { ledger, distribution, proof, options, locator };
}

describe('RevRule verified ERC-20 payout evidence', () => {
  it('links a verified transfer log without rewriting the original entitlement', async () => {
    const f = fixture();
    const before = structuredClone(f.ledger.entries()[0]);
    const item = await recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options);
    expect(item.type).toBe('PAYOUT_SETTLED');
    expect(item.payoutEvidence).toMatchObject({
      instructionId: f.distribution.instructionId,
      paymentKind: 'entitlement_payout', chainId: 8453, txHash: TX, logIndex: 3,
      senderAddress: SENDER, recipientAddress: RECIPIENT,
    });
    expect(f.ledger.entries()[0]).toEqual(before);
    expect(f.ledger.verifyChain()).toBe(true);
    const view = readEntitlementsWithPayouts(f.ledger, { graphId: 'revenue-graph' });
    expect(view).toHaveLength(1);
    expect(view[0]!.payouts).toHaveLength(1);
    expect(f.ledger.entries().filter(e => e.type === 'ENTITLEMENT')).toHaveLength(1);
  });

  it('is idempotent and rejects a conflicting settlement claim', async () => {
    const f = fixture();
    const one = await recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options);
    const replay = await recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options);
    expect(replay.hash).toBe(one.hash);
    expect(f.ledger.entries()).toHaveLength(2);
    const tx2 = '0x' + 'b'.repeat(64);
    await expect(recordVerifiedOnchainPayout(f.ledger, f.distribution,
      { ...f.locator, txHash: tx2 },
      { ...f.options, verifyTransfer: async () => ({ ...f.proof, txHash: tx2 }) },
    )).rejects.toThrow(/already has different/);
  });

  it('does not double-credit one transfer log to two separate entitlements', async () => {
    const f = fixture();
    await recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options);
    f.ledger.append({
      eventId: 'event-1', graphId: 'revenue-graph', graphVersion: 2,
      type: 'ENTITLEMENT', ruleId: 'other', participantId: 'developer',
      amountMicros: 1_000_000, reason: 'second claim',
    });
    const other = { ...f.distribution, instructionId: 'dist:event-1:other:developer' };
    await expect(recordVerifiedOnchainPayout(f.ledger, other, f.locator, f.options))
      .rejects.toThrow(/already attributed/);
  });

  it('supports two different transfer logs in one batch transaction', async () => {
    const f = fixture();
    await recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options);
    f.ledger.append({
      eventId: 'event-1', graphId: 'revenue-graph', graphVersion: 2,
      type: 'ENTITLEMENT', ruleId: 'other', participantId: 'developer',
      amountMicros: 1_000_000, reason: 'second claim',
    });
    const other = { ...f.distribution, instructionId: 'dist:event-1:other:developer' };
    const extra = await recordVerifiedOnchainPayout(f.ledger, other,
      { ...f.locator, logIndex: 4 },
      { ...f.options, verifyTransfer: async () => ({ ...f.proof, logIndex: 4 }) },
    );
    expect(extra.payoutEvidence?.logIndex).toBe(4);
    expect(f.ledger.verifyChain()).toBe(true);
  });

  it.each([
    ['failed tx', { transactionSucceeded: false }, /not independently verified/],
    ['wrong token', { tokenAddress: OTHER }, /configured payout token/],
    ['wrong sender', { senderAddress: OTHER }, /approved payout executor/],
    ['wrong payee', { recipientAddress: OTHER }, /entitlement destination/],
    ['wrong amount', { amountBaseUnits: '999999' }, /amount does not match/],
    ['unconfirmed', { confirmations: 1 }, /insufficient confirmations/],
    ['wrong chain', { chainId: 1 }, /verified receipt does not match/],
    ['wrong log index', { logIndex: 4 }, /verified receipt does not match/],
  ])('rejects %s without writing to ledger', async (_scenario, overrides, error) => {
    const f = fixture();
    await expect(recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator,
      { ...f.options, verifyTransfer: async () => ({ ...f.proof, ...overrides }) },
    )).rejects.toThrow(error);
    expect(f.ledger.entries()).toHaveLength(1);
  });

  it('rejects nonexistent instructions, unverified receipts and ledger tampering', async () => {
    const f = fixture();
    await expect(recordVerifiedOnchainPayout(f.ledger,
      { ...f.distribution, instructionId: 'dist:unrelated' }, f.locator, f.options,
    )).rejects.toThrow(/matching entitlement/);
    await expect(recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator,
      { ...f.options, verifyTransfer: async () => null },
    )).rejects.toThrow(/not independently verified/);
    f.ledger.entries()[0]!.amountMicros = 42;
    await expect(recordVerifiedOnchainPayout(f.ledger, f.distribution, f.locator, f.options))
      .rejects.toThrow(/hash chain is invalid/);
  });
});

describe('independent EVM receipt verifier (mock RPC only)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('verifies chain, receipt, exact ERC-20 Transfer log and confirmations', async () => {
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const topic = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
    const receipt = {
      transactionHash: TX, blockHash: BLOCK, blockNumber: '0x4d2', status: '0x1',
      logs: [{
        transactionHash: TX, logIndex: '0x3', removed: false,
        address: TOKEN, topics: [transferTopic, topic(SENDER), topic(RECIPIENT)],
        data: '0x' + BigInt(1_000_000).toString(16).padStart(64, '0'),
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      const packet = JSON.parse(init.body) as { method: string };
      const result = packet.method === 'eth_chainId' ? '0x2105'
        : packet.method === 'eth_getTransactionReceipt' ? receipt
        : packet.method === 'eth_blockNumber' ? '0x4e9'
        : null;
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    }));
    const check = createEvmRpcTransferVerifier('https://trusted-rpc.example');
    const result = await check({ chainId: 8453, txHash: TX, logIndex: 3 });
    expect(result).toMatchObject({
      chainId: 8453, txHash: TX, logIndex: 3,
      senderAddress: SENDER, recipientAddress: RECIPIENT, tokenAddress: TOKEN,
      amountBaseUnits: '1000000', transactionSucceeded: true, confirmations: 24,
    });
  });
});
