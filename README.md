# Payload Flow MVP — the Payload Rail

**Programmable revenue infrastructure engine.** The Payload Rail turns any
qualifying economic event — a Stripe payment, an x402 settlement, a royalty
statement row — into auditable entitlements, computed by a versioned,
stateful, cross-rail rule graph. One engine, no industry branches:
creative-economics splits, SaaS marketplace payouts, and machine-commerce
micropayments are all configurations of the same generic primitives.

**Live now:** the hosted Rail API at `https://payload-rail.fly.dev`
([quickstart](https://payloadhq.github.io/flow-rail.html)). Get a free API
key with one curl call, define a graph, send events. Or run the
[Flow Sandbox](https://payloadhq.github.io/flow-sandbox.html) in your
browser with no key at all.

## What it is

- A deterministic **evaluation engine**: rules consume from the pool
  (`net = amount − processingCost`) in priority order; `remainder` is a
  validated rule type that conserves the pool exactly.
- A **stateful rule language**: percentage, fixed, per_use, referral,
  recoupment (first-class, with defined intra-event step-down semantics),
  waterfall composites, capped / time_limited / milestone wrappers,
  first/last-touch attribution, remainder, plus the system rules
  `payload_fee` (rail-aware pricing engine v2) and `platform_fee`.
- An **append-only hash-chained ledger** with explainable entries
  (every ENTITLEMENT / FEE / SKIPPED entry links event → graph version →
  rule, with human-readable reasons).
- **Adapters as seams**: stripe, x402, and csv adapters translate
  source-native payloads into the canonical event envelope — translation
  only, never evaluation, never money movement.
- A **TypeScript SDK**: `defineGraph` → `activateGraph` → `processEvent`
  → `readLedger` → `simulateEvent` (dry-run, zero side effects).

## What it ISN'T

- **Not a payment processor.** It computes who is owed what; regulated
  partners (Stripe Connect, x402 facilitators) execute payouts.
- **Not custody.** Distributions are `proposed` instructions only — the
  engine never holds funds, never controls settlement timing.
- **No real-money execution in this repo.** Adapters run against supplied
  payloads; no live network calls are made by the engine or the tests.
  Live-rail acceptance was completed 2026-10-03/04: a real $1.00 Stripe
  charge, two real 0.10-USDC Base Sepolia settlements, and a synthetic
  $1,000 royalty statement, each processed by the real adapters and the
  Rail engine with the arithmetic verified to the micro-unit
  (see ACCEPTANCE.md). All distributions remain `proposed` — the engine
  never moves money.

## Money as micro-units

All amounts are **integer micro-units** (1e-6 of the major unit;
USD 1.00 = 1,000,000). Percentages are integer basis points. The single
rounding step is round-half-up per computed rule amount, via exact BigInt
arithmetic — no floats anywhere in the money path. `remainder` takes
whatever is left, so `sum(entitlements) + sum(fees) == pool` structurally.

## How to run

```bash
npm install
npm test        # full suite (vitest)
npm run build   # tsc -> dist/
```

## The three §7 validations

The decision package's three falsification walkthroughs run executable,
against ONE shared Rail deployment in a single test file:

```bash
npx vitest run test/validations.test.ts
```

- **Validation A — creative economics**: producer recoupment ($10,000
  advance at 20%, then 5%), 4% marketer share time-limited to 12 months,
  artist remainder. Proves the mid-event step-down (the advance completes
  *inside* one event) and window expiry skips.
- **Validation B — SaaS/marketplace**: $100 Stripe sale via the Stripe
  adapter — Payload fee (builder tier, 80bps of net), 6% platform fee, 10%
  conditional referral, 5% developer, owner remainder; second event without
  attribution skips the referral rule.
- **Validation C — machine commerce**: $0.10 x402 settle confirmation via
  the x402 adapter — Payload fee (free tier, allowance exhausted), $0.002
  per-use developer share, 10% referral to an **agent** participant with an
  x402 wallet destination (zero engine branching on participant kind),
  operator remainder; redelivery dedupes idempotently.

See `ACCEPTANCE.md` for the criterion-by-criterion mapping (including the
documented deviations from §7's illustrative figures).

## SDK quickstart

```ts
import {
  PayloadEvaluationEngine, InMemoryEventStore, InMemoryStateStore,
  InMemoryLedger, createFeeEngine, InMemoryVolumeTracker,
  defineGraph, activateGraph, processEvent, readLedger, simulateEvent,
} from '@payload/flow-rail';

// 1. Host constructs the engine pieces and binds them.
const deps = {
  eventStore: new InMemoryEventStore(),
  stateStore: new InMemoryStateStore(),
  ledger: new InMemoryLedger(),
  feeEngine: createFeeEngine(new InMemoryVolumeTracker()),
  accounting: { accountId: 'acct-1', license: { accountId: 'acct-1', tier: 'builder', grantedAt: '2026-01-01T00:00:00Z' } },
};
const engine = new PayloadEvaluationEngine(deps);

// 2. Define a graph from BLANK (generic primitives only) and activate it.
let graph = defineGraph({
  id: 'graph-1', projectId: 'proj-1', ownerId: 'owner',
  participants: [
    { id: 'owner', kind: 'person', roles: ['owner'], payoutDestinations: [{ rail: 'ach', address: 'bank:owner-acct-1' }] },
    { id: 'partner', kind: 'company', roles: ['contributor'], payoutDestinations: [{ rail: 'stripe', address: 'bank:partner-acct-2' }] },
  ],
  rules: [
    { id: 'split', type: 'percentage', priority: 10, params: { rateBps: 3000, subjectParticipantId: 'partner' } },
    { id: 'rest', type: 'remainder', priority: 100, params: { subjectParticipantId: 'owner' } },
  ],
});
graph = activateGraph(graph);

// 3. Process an event (direct envelope, or { adapter, raw } for translation).
const [result] = processEvent(engine, graph, deps, {
  eventId: 'e-1', graphId: 'graph-1', type: 'SALE_COMPLETED',
  occurredAt: '2026-01-15T00:00:00Z', amountMicros: 100_000_000,
  currency: 'USD', rail: 'stripe', processingCostMicros: 3_200_000, raw: {},
});

// 4. Read the ledger; dry-run future events with simulateEvent (no side effects).
const entries = readLedger(deps.ledger, { graphId: 'graph-1' });
const dryRun = simulateEvent(engine, graph, deps, { ...result /* event shape */ } as never);
```

## No-custody statement

The engine builds `Distribution` instructions with status `'proposed'`.
Nothing in this repository executes a payout, holds participant funds,
controls settlement timing, or calls a live payment API. Settlement is the
regulated partner's job; reconciliation compares partner reports against
the instructions. Any feature that would hold funds, delay settlement, or
fractionalize revenue interests is a licensing tripwire — counsel-gated,
never added silently.

## Repository layout

```
src/
  types.ts        # contracts: envelope, graph, rules, ledger, engine interfaces
  engine.ts       # PayloadEvaluationEngine (deterministic, stateful, idempotent)
  rules.ts        # rule language: validation + waterfall expansion
  fee-engine.ts   # pricing engine v2 (rail-aware)
  sdk.ts          # defineGraph / activateGraph / processEvent / readLedger / simulateEvent
  adapters/       # stripe.ts, x402.ts, csv.ts — translation only
  event-store.ts  # InMemoryEventStore (queryable log, touch events)
  state-store.ts  # InMemoryStateStore (recoupment balances, caps, counters)
  ledger.ts       # InMemoryLedger (append-only, hash-chained)
  graph.ts        # versioning + material-change approval gate
  reconciliation.ts / webhooks.ts
test/
  validations.test.ts  # §7 walkthroughs A/B/C + cross-proof (one Rail)
  engine.test.ts fee-engine.test.ts adapters.test.ts ledger.test.ts
  sdk.test.ts reconciliation.test.ts webhooks.test.ts
ARCHITECTURE_NOTES.md  # binding semantics + primitive-gap log
ACCEPTANCE.md          # §14 criterion-by-criterion evidence
```

## Capability labels

| Capability | Label |
|---|---|
| Rule engine, ledger, adapters (stripe/x402/csv), SDK, fee engine v2, simulator, reconciliation | Beta (implemented, validated by tests + live-rail acceptance) |
| Weighted multi-touch attribution, oracle milestones, stablecoin payout rail, LICENSE registry adjudication, contribution-graph verification | Modeled, not executed |
| Tax filing, securities-like revenue interests, dispute arbitration, multi-currency netting | Not yet modeled |
| Live-rail real-money acceptance | Passed 2026-10-03/04: Stripe $1.00, x402 2x 0.10 USDC (Base Sepolia), royalty CSV $1,000 (see ACCEPTANCE.md) |
