# Payload Flow — Persistent Economic Entitlement Charter

**Status:** CONSTITUTIONAL (2026-10-03) · **Supersedes nothing; extends the architecture**

## Core thesis

**The royalty belongs to the Revenue Graph, not the payment rail.**

An economic entitlement is a persistent relationship between a Revenue Graph and
its participants. It is independent of whichever payment rail, processor,
marketplace, wallet, or distributor happens to move the money for any given
event. "Royalty" here is the generic term for persistent economics attached to
music, film, software, APIs, creators, licensing, marketplaces, games, digital
products, referrals, AI agents, and future economic assets — never reduced to
any single industry.

## Persistence guarantees

An entitlement, once defined on a Revenue Graph, remains active for exactly the
duration its rule declares — no more, no less:

- **lifetime of qualifying revenue** — a rule with no end condition runs indefinitely;
- **a defined term** — `time_limited` / `effectiveTo` bounds the economics;
- **until a monetary cap is reached** — `capped` stops paying past the cumulative cap;
- **until recoupment is completed** — `recoupment` auto-transitions from recovery
  economics to residual economics (even within a single event);
- **until a milestone occurs** — `milestone` activates (or deactivates, by versioning)
  on a declared trigger;
- **indefinitely until amended or terminated** — rules persist across rail changes,
  source changes, and time; only a new graph version (owner-approved) or archival
  ends them.

First-class entitlement shapes (all executed by generic primitives, never
industry branches): LIFETIME, TERM, RECOUP-THEN-RESIDUAL, PER-USE RESIDUAL,
DERIVATIVE/DOWNSTREAM (via `derivedFrom` lineage on events + `RuleCondition`).

## Cross-rail continuity

Changing payment providers MUST NOT destroy the economic relationship.
Stripe today → another provider tomorrow → x402 later: the Revenue Graph stays
authoritative and the entitlement continues whenever qualifying revenue events
are mapped into Flow. Rules are rail-agnostic by default; `RuleCondition.rails`
is an opt-in scope filter, never a structural binding. `RevenueSource`s are
ingestion mappings, not parties to the agreement — a project owner maps a new
source onto the existing graph without recreating the economics.

## Versioning & auditability

Economic rules carry effective dates and immutable historical versions. A new
graph version applies to future events only; past ledger entries keep their
`graphVersion` forever. For every distribution Flow can explain: which
entitlement applied (ruleId), why (reason string), which revenue event
triggered it (eventId), which agreement version was active (graphVersion), and
how the amount was calculated (exact arithmetic in the reason). Skips are
ledgered with reasons — silence is never an explanation.

## Portability

Economic relationships are exportable as canonical, self-describing data
(`exportGraph`/`importGraph`), independent of any processor or integration.
No artificial lock-in: the agreement must be able to leave.

## Payload's own economics

Payload's commercial model follows the same philosophy. The initial license
purchase (the `License` tier) and Payload's ongoing infrastructure entitlement
(the `payload_fee` rule, computed per event by the fee engine) are separate
and both transparent. Continuing revenue is tied to actual routed economic
activity, computed in the open on every event — never secretly embedded.

## Non-goals (constitutional)

- Flow never takes custody, never executes payouts, never holds float.
- Flow never tracks the click; it adjudicates the claim.
- No vertical-specific branching in the engine. New industries arrive as
  configurations of these primitives, never as code forks.
