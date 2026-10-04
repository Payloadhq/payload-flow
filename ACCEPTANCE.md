# Acceptance — §14 criteria vs evidence

Source: `../DECISION_PACKAGE.md` §14 (MVP specification). Every criterion is
mapped to the test that proves it. All validation tests live in
`test/validations.test.ts` and run against ONE shared Rail deployment
(shared `InMemoryEventStore`, `InMemoryStateStore`, `InMemoryLedger`, one
`createFeeEngine` instance) in a single run.

Status: **126/126 tests green** (`npm test`), of which 17 are the §7
acceptance walkthroughs + cross-proof.

## Criterion table

| # | §14 acceptance criterion | Evidence (test name + location) | Status |
|---|---|---|---|
| 1 | Graph built from blank graph with generic primitives only | `test/validations.test.ts` — each validation's `describe` opens with **"builds from a blank graph with generic primitives only; activates"** (A, B, C). Graphs are constructed via `defineGraph` → `activateGraph`; no templates, no industry-specific types. | PASS |
| 2 | ≥3 participants, distinct roles, mixed payout destinations (C includes an agent with a wallet) | Same three "builds…" tests: A has producer/artist/marketer (person/person/company; contributor/owner/contributor); B has platform/affiliate/developer/owner (company/person/person/person); C has developer/`referring-agent`/operator — the agent's kind is asserted (`agent.kind === 'agent'`) and its payout destination is rail `x402` with a wallet address. Payout destinations are opaque strings (`bank:…` refs, `0x…` wallet). | PASS |
| 3 | Multiple rule types including one stateful rule (A: recoupment; B: conditional referral; C: per-use) | A: **"A1…"** + **"mid-event step-down…"** exercise `time_limited` (wrapper), `recoupment` (stateful — balance read from the state store), `remainder`. B: **"B1…"** + **"B2…"** exercise `payload_fee`, `platform_fee`, `referral` with `requireAttribution`, `percentage`, `remainder`. C: **"C1…"** exercises `payload_fee`, `per_use` ($0.002/unit), `referral`, `remainder`. | PASS |
| 4 | Real transaction on a real rail at low value | **OWNER-GATED — not yet earned.** The tests use the real adapter translation code (stripe/x402/csv) against *supplied* payloads; no live network calls, no real money. A live low-value transaction per rail is still required before production claims. | BLOCKED |
| 5 | Event → Rail → correct entitlements; Payload fee matches engine v2 math | A: **"A1: $1,000 royalty via the CSV adapter splits exactly"** (40_000_000 / 192_000_000 / 768_000_000 micros, exact). B: **"B1…"** — 80bps builder-tier fee = 774_400 micros on net 96_800_000, plus exact per-participant micros. C: **"C1…"** — 100bps free-tier fee (allowance pre-exhausted) = 980 micros on net 98_000, plus exact micros. | PASS |
| 6 | Regulated partner executes/schedules the payout; no Flow custody | `test/validations.test.ts` — C **"C1…"**: asserts every `Distribution.status === 'proposed'` and that the agent's instruction carries the x402 wallet destination — instructions built, never executed. Engine-level: `src/engine.ts` `buildDistributions` always sets `status: 'proposed'`; `test/engine.test.ts` covers distribution construction. | PASS |
| 7 | All parties can inspect the ledger; a skipped rule shows its reason | Every validation test calls `assertLedgerLinkage(eventId, graphId)` (eventId → graphVersion → ruleId on each ENTITLEMENT/FEE/SKIPPED entry). Skip reasons: A **"expiry…"** (`outside effective window […]`), B **"B2…"** (`no referrer claim`), C **"no attribution claim …"** — each also asserts the SKIPPED entry is *on the ledger* with its reason. Ledger reads: `readLedger` covered in `test/sdk.test.ts`. | PASS |
| 8 | A second transaction processes automatically with no reconfiguration | A: **"second transaction is automatic…"** (new eventId, no graph change; recouped balance 192M → 384M). B: **"B2…"** (second Stripe event, same graph). C: **"a new txHash is a new transaction…"**. C additionally proves **"redelivery … is an idempotent replay"** (same confirmation → `idempotentReplay: true`, no new ledger entries, no volume double-count). | PASS |
| 9 | Cross-proof: all three graphs evaluated by the same Rail deployment in one acceptance run | `test/validations.test.ts` — final `describe` **"Cross-proof — one Rail deployment evaluates all three graphs"**: the shared ledger holds entries for graph-a/b/c and `verifyChain()` is true; state is per-graphId (no interference); volume is per-accountId (`acct-a`/`acct-b`/`acct-c` deterministic per validation). | PASS |

## §7 illustrative-number deviations (documented, not defects)

The walkthroughs in DECISION_PACKAGE.md §7 used illustrative figures under
assumptions the engine does not share. The validations assert the engine's
**documented** math (ARCHITECTURE_NOTES.md: micro-units, sequential pool
consumption from `net = amount − processingCost`, round-half-up per computed
amount, remainder conserves the pool).

| Case | §7 / brief figure | Validated figure | Cause |
|---|---|---|---|
| A1 marketer | $39.80 | $40.00 (40_000_000 µ) | §7 assumed a 0.5% top-line fee taken before splits. The engine has no `payload_fee` rule on graph A, so the pool is the full $1,000; marketer (priority 10) takes 4% of $1,000. |
| A1 producer | $199 | $192.00 (192_000_000 µ) | Same fee-placement assumption, plus priority order: producer recoups 20% of the pool *after* the marketer's 4% ($960), not 20% of $995. |
| A1 artist | $756.20 | $768.00 (768_000_000 µ) | Remainder of the above. Pool conserved: 40 + 192 + 768 = 1,000. |
| B2 developer | $4.80 (brief: 4_061_883 µ) | $4.513203 (4_513_203 µ) | Skipped rules consume **nothing**: the developer (priority 30) computes its 5% on the pool the skipped referral (priority 20) left untouched (90_264_064), not on the referral-reduced pool. Engine-literal sequential consumption. |
| B2 owner | $75.86 + $9.60 (brief: 86_202_181 µ) | $85.750861 (85_750_861 µ) | Remainder of the above: 90_264_064 − 4_513_203. Pool conserved: 774_400 + 5_761_536 + 4_513_203 + 85_750_861 = 96_800_000. |
| A mid-event | $50 completes, then $2,487.50 at 5% | $16.00 completes (need $16.00), then $44.00 at 5% on the same pool | Same engine semantics at the actual scale of the test ($1,000 events against a $10,000 advance; the brief's $50,000 event was illustrative). Producer $60.00, artist $900.00 on the crossing event. |
| A expiry artist | $4,726.25 | $4,750.00 (4_750_000_000 µ) | Follows from the A1 deviation: producer 5% of the full $5,000 pool = $250.00; remainder $4,750.00. Marketer correctly skipped past its window. |

The thesis is unaffected: three unrelated economies executed on one generic
engine with zero vertical branching. The primitive-gap log in
ARCHITECTURE_NOTES.md records **NONE** — all three validations ran without
any industry-specific code in the engine, SDK, adapters, or tests.

## How to re-run

```bash
npm test                              # full suite: 126/126
npx vitest run test/validations.test.ts  # §7 walkthroughs + cross-proof: 17/17
```
