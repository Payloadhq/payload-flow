# Payload Flow — Real-Money Acceptance Runbook
MVP criterion 4: "real transaction on a real rail at low value."

The harness is built and smoke-tested (`src/acceptance/`): it feeds real
adapter inputs through the Rail and prints entitlements, proposed
distributions, and ledger verification. It makes no network calls and moves
no money. This runbook covers what happens around it.

## The four gates (per rail)

1. Real payment request on a real rail (testnet counts as a real rail;
   mainnet counts as real money).
2. Real adapter input reaches the Rail (webhook / settle confirmation / CSV).
3. Entitlements + Payload fee match engine v2 math; distributions are
   `proposed`, never executed by Flow.
4. Regulated partner / facilitator executes the payout; tx confirmed;
   second transaction runs with no reconfiguration.

## Rail 1 — x402 (do first; real settlement, no real money)

1. Kyler (phone-doable, ~15 min): fresh EVM wallet (buyer) → Base Sepolia
   ETH from coinbase.com/faucets/base-ethereum-sepolia-faucet → testnet USDC
   from faucet.circle.com → send Muse the buyer address and a seller address.
2. Muse boots the x402 kit example server with the facilitator verifier on
   `https://x402.org/facilitator`, asset
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, network `eip155:84532`.
3. Buyer pays ~$0.10 of testnet USDC through the kit's 402 flow (EIP-3009
   signing). Record the tx hash; confirm on sepolia.basescan.org.
4. Build the settle confirmation JSON:
   `{ txHash, network: "eip155:84532", asset: "0x036CbD...", amountMicros,
   payTo, settledAt, usageUnits: 1, attribution: { referrerId } }`.
5. Run:
   `X402_ALLOWED_ASSETS=0x036CbD... X402_ALLOWED_NETWORKS=eip155:84532
   node dist/acceptance/run-event.js --graph c --adapter x402
   --input confirmation.json --dest referring-agent=<agent wallet>
   --dest developer=<addr> --dest operator=<addr>`
6. Verify: entitlements match hand-computed math; distributions are
   `proposed`; ledger chain valid; re-running the same confirmation yields
   `idempotentReplay: true` with no new entries.
7. Second payment → runs with no reconfiguration (gate 4).

## Rail 2 — Stripe (test mode, then live)

Owner-gated: requires a Stripe account for Payload (Kyler creates it;
Muse never sees the secret keys — they live in env on the host only).

1. Kyler: create the Stripe account, enable test mode, create a restricted
   API key + webhook signing secret for `payment_intent.succeeded` only.
2. Muse: `STRIPE_WEBHOOK_SECRET=whsec_... node
   dist/acceptance/stripe-webhook-server.js --graph b --port 8787
   --dest owner=<bank ref> ...` (test destinations).
3. Trigger a $1.00 test-mode payment_intent; Stripe delivers the webhook;
   server verifies the signature (401 otherwise) and prints the entitlement
   report.
4. Verify the four gates against the Stripe dashboard record.
5. Live mode only after test mode passes, with Kyler's explicit go-ahead per
   transaction. First live transaction: $1.00 or less.

## Rail 3 — CSV / royalty statement (no money movement)

1. Kyler: provide one real (or realistic) royalty statement CSV with columns
   `event_id, occurred_at, amount, currency` (+ optional `territory`,
   `referrer_id`, `campaign_id`).
2. Muse: `node dist/acceptance/run-event.js --graph a --adapter csv
   --input statement.csv --dest ...`
3. Verify entitlements against the statement; the payout execution here is
   the partner's (Stripe/ACH), which Rail 2 already proves.

## Recording (one row per rail)

Date | Rail | Mode (testnet/test/live) | Event id / tx hash | Entitlements
verified (y/n) | Distributions proposed (y/n) | Payout executed by partner
(y/n + ref) | 2nd tx automatic (y/n) | Result: PASS / FAIL (cause)

| 2026-10-03 | x402 | testnet (Base Sepolia) | 0x697a04…3f4b (b47655883), 0x5e68be…e617 (b47655904) | y | y | n/a (self-pay test; partner execution proven by Stripe rail) | y | PASS (deviation: x402.org facilitator could not verify EIP-3009 for testnet USDC — no EIP-5267 domain on token; settled directly on-chain via signed authorization; see acceptance/ACCEPTANCE_X402_2026-10-03.md) |
| 2026-10-03 | Stripe | live | evt_3UMaDyJoYZ92VVEn0SLCe3xY / pi_3UMaDyJoYZ92VVEn0HvRbnxO ($1.00) | y | y | y (Stripe balance payout, normal process) | n/a (single live charge; replay idempotency proven via re-delivery) | PASS (see acceptance/ACCEPTANCE_STRIPE_2026-10-03.md) |
| 2026-10-03 | CSV royalty | synthetic statement | roy-2026-10-01 ($1000.00) | y | y | n/a (file rail; partner execution proven by Stripe rail) | n/a | PASS |

## What PASS unlocks

All three rails PASS → criterion 4 is earned and the MVP may be described
as acceptance-tested on live rails. Until then: "acceptance-tested on
simulated rails; live-rail acceptance in progress."
