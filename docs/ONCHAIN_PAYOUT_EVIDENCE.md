# RevRule — Verified on-chain payout evidence

STATUS: SDK implementation on an isolated branch. NOT YET HOSTED IN PRODUCTION.

## Purpose

RevRule already computes a versioned, hash-chained entitlement: event, graph, rule, participant, and amount. But an on-chain revenue split is indistinguishable from other transfers unless the payout is linked back to the underlying entitlement. The incoming x402 API fee is NOT itself an outgoing entitlement payout.

## Implementation

A trusted, non-custodial settlement integration can append a PAYOUT_SETTLED ledger entry with payoutEvidence:
- Existing entitlement and payout instruction identity: eventId, graphId, graphVersion, ruleId, participantId, instructionId.
- paymentKind: entitlement_payout (not new economic activity).
- EVM chain ID, transaction hash, log index, block hash and block number.
- Trusted ERC-20 token, authorized sending address, recipient address, exact base-unit amount.
- Confirmations at the time of verification and a trusted verifier identifier.

The append-only evidence record is linked by instructionId. The original ENTITLEMENT line is never edited; no new SALE/API_PAYMENT is created; there is no balance or fee mutation. The readEntitlementsWithPayouts method returns the entitlement and evidence side-by-side.

The composite transfer identifier is (chainId, txHash, logIndex), not txHash alone. One blockchain transaction can contain several Transfer logs. Evidence for one instruction is idempotent; the same transfer log cannot be reused for another instruction.

## Safe invocation

Only after an authorized payout partner confirms an actual payout:

1. Obtain the partner's payout instruction ID plus chainId, txHash and logIndex from its confirmed settlement report.
2. Obtain chain receipt/log facts through createEvmRpcTransferVerifier with a trusted, server-configured HTTPS EVM RPC endpoint. NEVER use arbitrary user-provided RPC URLs.
3. Call recordVerifiedOnchainPayout(ledger, distribution, locator, options), providing the independently verified expected chain, token contract, exact token decimals, authorized sender, recipient and confirmation policy.
4. Render readEntitlementsWithPayouts(ledger) for authorized customer audit, showing transaction/log next to entitlement and rule.
5. Continue keeping actual payment execution and key custody outside the RevRule engine.

The RPC verifier reads chain ID, receipt status, ERC-20 Transfer event and block height. It never sends transactions or touches private keys.

## Honest limitations

- A tx hash proves a transfer's chain facts, not business intent. The intent-to-transfer connection is asserted by a trusted payout partner or controller. Authorized sender matching helps, but on-chain events alone cannot prove the contract purpose.
- Confirmation count is a point-in-time check. Configure a suitable finality/reorganization policy before commercial adoption and add immutable correction events for reorgs.
- This implementation handles one full ERC-20 payout per instruction only. Partial payments, non-EVM settlement, multiple tokens/currency conversion, and reorg corrections are not in scope.
- The default SDK InMemoryLedger is not persistent. Before a hosted production claim, wire these entries to the actual durable ledger, authenticated route, trusted partner verification, recovery, and customer-facing UI. Re-run full end-to-end acceptance and confirm live deployment.
- Never count payout evidence as additional agent spending, revenue, or a new entitlement.
- Publishing this branch or merging its pull request does NOT by itself make this a live hosted RevRule capability.

## Tests

test/payout-evidence.test.ts exercises linkages, replay, duplicate-transfer prevention, batch transfer distinction, mismatched sender/token/payee/amount, confirmation failures, ledger tampering, and a mocked EVM receipt verifier. No live money is spent.
