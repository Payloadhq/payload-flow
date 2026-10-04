# Payload Flow MVP — Architecture Notes

## Decisions

- **Money = integer micro-units** (1e-6 of major unit; USD 1.00 = 1_000_000).
  No floats anywhere in the money path. Percentages are integer basis points.
  Rounding: round-half-up to the microdollar per computed rule amount;
  `remainder` takes whatever is left, so pool conservation is structural.
- **Evaluation order = priority order, sequential pool consumption.** Rules
  consume from the pool (net = amount − processingCost) in ascending priority.
  `remainder` is validated to be exactly one per graph and lowest priority.
- **Recoupment is first-class**, not two conditional rules: `{advance,
  recoupRate, postRate}` with defined intra-event semantics (an event can
  complete the advance partway; the rest of the same event's pool accrues at
  the post rate). Recoupment-of-capital is universal (producer advance, film
  financier, SaaS investor), not musical.
- **Attribution boundary (honest):** adapters ASSERT attribution from what
  they observe; Rail CONSUMES it as a first-class event dimension and
  ADJUDICATES via attribution rules over ingested touch events. "Flow never
  tracks the click; it adjudicates the claim." Touch events are zero-amount
  `ECONOMIC_EVENT`s; the event store is a first-class queryable log.
- **Fee engine is rail-aware from the envelope alone** (`rail` +
  `processing_cost` → schedule table). Data, not code.
- **No-custody is constitutional:** the engine builds `Distribution`
  instructions with status `proposed`. Nothing executes them, nothing holds
  funds, nothing controls settlement timing. No minimum-payout holds, no
  reserves, no float — these are tripwire features requiring licensing review.
- **Graph versioning:** rule changes create new versions; history immutable;
  material changes go through the pending-change approval gate (owner
  approves). Changes apply to future events only.

## Primitive gaps found during build

**Result of the three §7 executable validations: NONE.** Validations A
(creative economics), B (SaaS/marketplace), and C (machine commerce) all
executed end-to-end on the generic engine with zero vertical-specific
branching — in the engine, the SDK, the adapters, and the acceptance tests
themselves (`test/validations.test.ts` runs all three against one shared
Rail deployment). No validation step required industry-specific logic; no
missing primitive had to be named.

Observations recorded during validation (documented semantics, not gaps):

1. **Waterfall `upToMicros` runtime extension on PercentageParams.** A
   waterfall composite expands its tranches into ordered percentage rules
   carrying `upToMicros`; the engine honors the per-tranche ceiling at
   runtime (`engine.ts`, percentage case). This is a documented
   composite-expansion mechanic, not vertical branching — the ceiling
   semantics are generic (any ordered percentage-with-ceiling split).
2. **Wrapper-nesting restriction.** Waterfall composites cannot nest inside
   `capped` / `time_limited` / `milestone` wrappers — `validateGraph`
   rejects this with an explicit error (`waterfall composites cannot be
   nested inside '…' wrappers`) rather than guessing semantics. Wrappers
   wrap primitive allocation rules only; composites go top-level. An
   explicit validation error is the correct generic behavior: no silent
   interpretation.
3. **Free-allowance rail-floor wrinkle.** Inside the free tier's $1,000
   lifetime allowance the fee formula still applies
   `max(rail_floor[rail], …)`, so a Stripe event fully inside the free band
   still assesses the $0.01 rail floor — formula-literal behavior, asserted
   in `test/fee-engine.test.ts` (microtransaction sweep). Not a vertical,
   not a bug; but worth knowing when reading fee lines on small Stripe
   events in the free band.
4. **§7 illustrative-number deviations.** The decision-package walkthroughs
   used illustrative figures computed under different fee-placement
   assumptions (a 0.5% top-line fee for A; gross-based percentages for
   B/C). The engine computes per documented semantics — every rule consumes
   from the pool = amount − processingCost in priority order, round-half-up
   per computed amount, remainder conserves the pool. Validation A therefore
   produces marketer $40 / producer $192 / artist $768 (vs §7's
   $199/$39.80/$756.20); B and C likewise track the documented
   priority-ordered consumption (including the B2 consequence that a
   skipped referral leaves a larger pool for the later 5% developer rule).
   Full deviation table in ACCEPTANCE.md. The horizontal thesis is
   unaffected — the validations assert the engine's documented math,
   exactly.

## Vertical-branching temptations

None taken. The closest call was Validation C's referring agent: a
`Participant` of kind `'agent'` with an x402 wallet destination. It required
zero engine branching — the agent flows through the identical referral-rule
code path as a human referrer; only the destination rail on the
`proposed` distribution instruction differs. Recorded in
`test/validations.test.ts` (Validation C) as a standing proof that
participant kind is data, not a code path.

## Modeled vs executed map (v1)

| Capability | Status |
|---|---|
| Rule types: percentage, fixed, per_use, referral, recoupment, waterfall (composite), capped, time_limited, milestone (manual trigger), attribution (first/last-touch), remainder, payload_fee, platform_fee | EXECUTED |
| Event envelope + adapters (stripe, x402, csv) | EXECUTED |
| Queryable event store + touch events | EXECUTED |
| Hash-chained append-only ledger | EXECUTED |
| Stateful evaluation (recoupment balances, caps, counters) | EXECUTED |
| Idempotency (event_id dedup) | EXECUTED |
| Graph versioning + material-change approval gate | EXECUTED |
| Fee engine v2 (rail-aware) | EXECUTED |
| Webhooks-out | EXECUTED |
| Reconciliation (ledger vs partner reports → exceptions queue) | EXECUTED |
| SDK (graph builder, event emission, ledger reads, dry-run simulator) | EXECUTED |
| LICENSE registry | MODELED, NOT EXECUTED (schema + rule-condition references; no validity adjudication) |
| Contribution graph | MODELED, NOT EXECUTED (auto-written from executions; no verification UX) |
| Weighted multi-touch attribution | MODELED, NOT EXECUTED (schema supports weights; v1 = first/last-touch) |
| Oracle milestones | MODELED, NOT EXECUTED (schema; v1 = manual trigger only) |
| Stablecoin payout rail | MODELED, NOT EXECUTED (schema; counsel-gated) |
| Tax filing | NOT EXECUTED (partner-owned; we hold tax_profile_ref only) |
| Securities-like revenue interests | NOT YET MODELED |
| Dispute arbitration workflows | NOT YET MODELED |
| Multi-currency netting | NOT YET MODELED |
