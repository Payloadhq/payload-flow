> **Payload** — Developer infrastructure for x402, agent payments, and programmable revenue.
> PAYLOAD → VEYLINE (flagship) → CALLX402 (action layer) → REVRULE (separate) → developer products → free utilities.
> This repo: **RevRule by Payload — programmable revenue rules engine (this repo holds the engine).**

<p align="center"><img src="docs/logo.png" alt="payload-flow logo" width="200"></p>
# RevRule by Payload - Programmable Revenue Rules Engine

**RevRule** turns any qualifying economic event (a Stripe payment, an x402
settlement, a royalty statement row) into auditable entitlements, computed by
a versioned, stateful, cross-rail rule graph. One engine, no industry
branches: creative-economics splits, SaaS marketplace payouts, and
machine-commerce micropayments are all configurations of the same generic
primitives.

**Live now:** the hosted Rail API at `https://payload-rail.fly.dev`
([quickstart](https://payloadhq.github.io/flow-rail.html)). Get a free API key
with one curl call, define a graph, send events. Or run the
[Flow Sandbox](https://payloadhq.github.io/flow-sandbox.html) in your browser
with no key at all.

## What it is

- A deterministic **evaluation engine**: rules consume from the pool
  (`net = amount - processingCost`) in priority order; `remainder` is a
  validated rule type that conserves the pool exactly.
- A **stateful rule language**: percentage, fixed, per_use, referral,
  recoupment (first-class, with defined intra-event step-down semantics),
  waterfall composites, capped / time_limited / milestone wrappers,
  first/last-touch attribution, remainder, plus the system rules
  `payload_fee` (rail-aware pricing engine v2) and `platform_fee`.
- An **append-only hash-chained ledger** with explainable entries (every
  ENTITLEMENT / FEE / SKIPPED entry links event to graph version to rule,
  with human-readable reasons).
- **Adapters as seams**: stripe, x402, and csv adapters translate
  source-native payloads into the canonical event envelope. Translation
  only: never evaluation, never money movement.
- A **TypeScript SDK**: `defineGraph` to `activateGraph` to `processEvent`
  to `readLedger`, plus `simulateEvent` (dry-run, zero side effects).

## What it ISN'T

- **Not a payment processor.** It computes who is owed what; regulated
  partners (Stripe Connect, x402 facilitators) execute payouts.
- **Not custody.** Distributions are `proposed` instructions only. The
  engine never holds funds and never controls settlement timing.
- **No real-money execution in this repo.** Adapters run against supplied
  payloads; the engine and tests make no live network calls. A live-rail
  acceptance run passed 2026-10-03/04: a real $1.00 Stripe charge and two real
  0.10-USDC Base Sepolia settlements, each processed by the real adapters
  and the Rail engine with the arithmetic verified to the micro-unit. Full
  evidence is in
  `acceptance/ACCEPTANCE_STRIPE_2026-10-03.md` and
  `acceptance/ACCEPTANCE_X402_2026-10-03.md` (not yet pushed to this repo;
  the published ACCEPTANCE.md covers the pre-live criteria). All
  distributions remain `proposed`.

## How to run

```bash
npm install
npm test        # full suite (vitest)
npm run build   # tsc -> dist/
```

The three falsification walkthroughs (creative economics, SaaS/marketplace,
machine commerce) run executable against one shared Rail deployment:

```bash
npx vitest run test/validations.test.ts
```

See `ACCEPTANCE.md` for the criterion-by-criterion evidence mapping.

## Money as micro-units

All amounts are **integer micro-units** (1e-6 of the major unit; USD 1.00 =
1,000,000). Percentages are integer basis points. The single rounding step
is round-half-up per computed rule amount, via exact BigInt arithmetic. No
floats anywhere in the money path. `remainder` takes whatever is left, so
`sum(entitlements) + sum(fees) == pool` structurally.

## Capability labels

| Capability | Label |
|---|---|
| Rule engine, ledger, adapters (stripe/x402/csv), SDK, fee engine v2, simulator, reconciliation | Beta (implemented, validated by tests + live-rail acceptance) |
| Weighted multi-touch attribution, oracle milestones, stablecoin payout rail, LICENSE registry adjudication, contribution-graph verification | Modeled, not executed |
| Tax filing, securities-like revenue interests, dispute arbitration, multi-currency netting | Not yet modeled |

## Links

- Rail quickstart: https://payloadhq.github.io/flow-rail.html
- Browser sandbox (no key needed): https://payloadhq.github.io/flow-sandbox.html
- Human console: https://github.com/Payloadhq/revrule-console
- Telegram: https://t.me/payloadtool
- Patreon: https://patreon.com/PayloadTools

## License

MIT - see [LICENSE](LICENSE). Copyright 2026 Payload.
