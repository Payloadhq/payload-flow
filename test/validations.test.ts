/**
 * validations.test.ts — DECISION_PACKAGE.md §7 acceptance walkthroughs, executable.
 *
 * The three falsification attempts on the universality thesis, run for real:
 * Validation A (creative economics), Validation B (SaaS/marketplace), and
 * Validation C (machine commerce) execute against ONE shared Rail deployment
 * (one event store, one state store, one ledger, one fee engine) in a single
 * test run — the §14 cross-proof.
 *
 * Conventions enforced throughout:
 * - Zero vertical-specific code: every graph is built from a BLANK graph with
 *   generic primitives only (person/company/agent participants, percentage /
 *   per_use / referral / recoupment / remainder / payload_fee / platform_fee
 *   rules, time_limited wrapper, stripe / x402 / csv adapters). The engine
 *   never branches on what the participants ARE — e.g. the Validation C
 *   referring agent (kind 'agent', x402 wallet destination) flows through the
 *   exact same code path as a human referrer.
 * - Money asserted in integer micro-units, exact.
 * - Deterministic: all timestamps fixed; no wall-clock assertions. (The x402
 *   adapter freshness guard is satisfied by a fixed settledAt with a long
 *   maxAgeMs configured on the adapter — no wall-clock dependence in the
 *   assertions.)
 * - Ledger spot-checks: every checked ENTITLEMENT / FEE / SKIPPED entry links
 *   eventId -> graphVersion -> ruleId.
 */
import { describe, expect, it } from 'vitest';
import { PayloadEvaluationEngine, mulDivRoundHalfUp } from '../src/engine.js';
import { InMemoryEventStore } from '../src/event-store.js';
import { InMemoryStateStore } from '../src/state-store.js';
import { InMemoryLedger } from '../src/ledger.js';
import { createFeeEngine, InMemoryVolumeTracker } from '../src/fee-engine.js';
import { createStripeAdapter } from '../src/adapters/stripe.js';
import { createX402Adapter } from '../src/adapters/x402.js';
import { createCsvAdapter } from '../src/adapters/csv.js';
import { defineGraph, activateGraph, processEvent } from '../src/sdk.js';
import type {
  EconomicEvent,
  EngineDeps,
  EvaluationResult,
  License,
  LicenseTier,
  Participant,
  RevenueGraph,
  Rule,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// ONE Rail deployment for the whole cross-proof (shared stores + engine).
// Volume is tracked per accountId, so each validation gets its own account:
// 'acct-a' / 'acct-b' / 'acct-c'. State is per graphId, so the three graphs
// never interfere.
// ---------------------------------------------------------------------------

const volumeTracker = new InMemoryVolumeTracker();
const shared = {
  eventStore: new InMemoryEventStore(),
  stateStore: new InMemoryStateStore(),
  ledger: new InMemoryLedger(),
  feeEngine: createFeeEngine(volumeTracker),
};

function license(accountId: string, tier: LicenseTier): License {
  return { accountId, tier, grantedAt: '2026-01-01T00:00:00Z' };
}

const depsA: EngineDeps = { ...shared, accounting: { accountId: 'acct-a', license: license('acct-a', 'free') } };
const depsB: EngineDeps = { ...shared, accounting: { accountId: 'acct-b', license: license('acct-b', 'builder') } };
const depsC: EngineDeps = { ...shared, accounting: { accountId: 'acct-c', license: license('acct-c', 'free') } };

const engine = new PayloadEvaluationEngine(depsA);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap the single result processEvent must return for a one-event input. */
function single(results: EvaluationResult[]): EvaluationResult {
  if (results.length !== 1) throw new Error(`expected exactly one result, got ${results.length}`);
  return results[0]!;
}

function entitlement(res: EvaluationResult, participantId: string): number {
  const e = res.entitlements.find((x) => x.participantId === participantId);
  if (!e) throw new Error(`no entitlement for '${participantId}' in event '${res.eventId}'`);
  return e.amountMicros;
}

function feeAmount(res: EvaluationResult, kind: 'payload_fee' | 'platform_fee'): number {
  const f = res.fees.find((x) => x.kind === kind);
  if (!f) throw new Error(`no ${kind} fee in event '${res.eventId}'`);
  return f.amountMicros;
}

/** Spot-check the eventId -> graphVersion -> ruleId linkage on ledger entries. */
function assertLedgerLinkage(eventId: string, graphId: string): void {
  const linked = shared.ledger
    .entriesForEvent(eventId)
    .filter((e) => e.type === 'ENTITLEMENT' || e.type === 'FEE' || e.type === 'SKIPPED');
  expect(linked.length).toBeGreaterThan(0);
  for (const e of linked) {
    expect(e.eventId).toBe(eventId);
    expect(e.graphId).toBe(graphId);
    expect(e.graphVersion).toBe(1);
    expect(e.ruleId).toBeTruthy();
  }
}

function participant(id: string, kind: Participant['kind'], roles: string[], destRail: Participant['payoutDestinations'][number]['rail'], address: string): Participant {
  return { id, kind, roles, payoutDestinations: [{ rail: destRail, address }] };
}

// ---------------------------------------------------------------------------
// VALIDATION A — creative economics (blank graph, generic primitives only)
// ---------------------------------------------------------------------------

const GRAPH_A = 'graph-a';
const RECOUP_RULE_A = 'r-recoup';
const ADVANCE_MICROS = 10_000_000_000; // $10,000

const MARKETING_FROM = '2026-01-01T00:00:00Z';
const MARKETING_TO = '2027-01-01T00:00:00Z'; // 12 months

let graphA: RevenueGraph = activateGraph(
  defineGraph({
    id: GRAPH_A,
    projectId: 'proj-a',
    ownerId: 'artist', // the 'owner' role carries the approval gate
    participants: [
      participant('producer', 'person', ['contributor'], 'ach', 'bank:producer-acct-4821'),
      participant('artist', 'person', ['owner'], 'stripe', 'bank:artist-acct-9302'),
      participant('marketer', 'company', ['contributor'], 'ach', 'bank:marketer-acct-1177'),
    ],
    revenueSources: [{ id: 'rs-a', kind: 'csv', config: {}, eventTypes: ['ROYALTY_RECEIVED'] }],
    rules: [
      {
        id: 'r-marketing',
        type: 'time_limited',
        priority: 10,
        params: {
          inner: {
            id: 'r-marketing-inner',
            type: 'percentage',
            priority: 10,
            params: { rateBps: 400, subjectParticipantId: 'marketer' }, // 4%
          },
          effectiveFrom: MARKETING_FROM,
          effectiveTo: MARKETING_TO,
        },
      },
      {
        id: RECOUP_RULE_A,
        type: 'recoupment',
        priority: 20,
        params: {
          subjectParticipantId: 'producer',
          advanceMicros: ADVANCE_MICROS,
          recoupRateBps: 2000, // 20% until the advance completes
          postRateBps: 500, // 5% thereafter
        },
      },
      {
        id: 'r-residual',
        type: 'remainder',
        priority: 100,
        params: { subjectParticipantId: 'artist' },
      },
    ] as Rule[],
  }),
);

const csvA = createCsvAdapter({ graphId: GRAPH_A });

function royaltyEvent(eventId: string, occurredAt: string, amountMicros: number): EconomicEvent {
  return {
    eventId,
    graphId: GRAPH_A,
    type: 'ROYALTY_RECEIVED',
    occurredAt,
    amountMicros,
    currency: 'USD',
    rail: 'manual', // CSV statements arrive on the manual rail; processing cost 0
    processingCostMicros: 0,
    raw: {},
  };
}

describe('Validation A — creative economics (§7 walkthrough, executable)', () => {
  it('builds from a blank graph with generic primitives only; activates', () => {
    expect(graphA.status).toBe('active');
    expect(graphA.participants.map((p) => p.id).sort()).toEqual(['artist', 'marketer', 'producer']);
    expect(graphA.rules.map((r) => r.type).sort()).toEqual(['recoupment', 'remainder', 'time_limited']);
  });

  it('A1: $1,000 royalty via the CSV adapter splits exactly', () => {
    const res = single(
      processEvent(
        engine,
        graphA,
        depsA,
        {
          adapter: csvA,
          raw: 'event_id,occurred_at,amount,currency\na1,2026-01-15T00:00:00Z,1000.00,USD\n',
        },
      ),
    );
    expect(res.eventId).toBe('csv_a1');
    expect(res.idempotentReplay).toBe(false);
    expect(res.fees).toEqual([]); // no payload_fee rule on this graph

    // §14/§7 deviation note: §7's illustrative figures ($199/$39.80/$756.20)
    // assumed a 0.5% top-line fee; the engine computes on the pool per
    // documented semantics, hence $40/$192/$768. See ACCEPTANCE.md.
    expect(entitlement(res, 'marketer')).toBe(40_000_000); // 4% of $1,000 = $40
    expect(entitlement(res, 'producer')).toBe(192_000_000); // 20% of $960 = $192
    expect(entitlement(res, 'artist')).toBe(768_000_000); // remainder = $768
    expect(entitlement(res, 'marketer') + entitlement(res, 'producer') + entitlement(res, 'artist')).toBe(
      1_000_000_000,
    ); // pool conserved

    const reasons = new Map(res.entitlements.map((e) => [e.participantId, e.reason]));
    expect(reasons.get('marketer')).toBe('4.00% of remaining pool $1000.00 -> $40.00');
    expect(reasons.get('producer')).toContain('recoupment:');
    expect(reasons.get('artist')).toBe('remainder of pool -> $768.00');

    // Stateful rule: the producer's recouped balance advanced by $192.
    expect(shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped')).toBe(192_000_000);

    assertLedgerLinkage('csv_a1', GRAPH_A);
  });

  it('second transaction is automatic: no reconfiguration, balance compounds', () => {
    const res = single(processEvent(engine, graphA, depsA, royaltyEvent('a2', '2026-01-16T00:00:00Z', 1_000_000_000)));
    expect(res.idempotentReplay).toBe(false);
    expect(entitlement(res, 'marketer')).toBe(40_000_000);
    expect(entitlement(res, 'producer')).toBe(192_000_000);
    expect(entitlement(res, 'artist')).toBe(768_000_000);
    // Recouped balance compounds across events: $192 + $192 = $384.
    expect(shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped')).toBe(384_000_000);
    assertLedgerLinkage('a2', GRAPH_A);
  });

  it('mid-event step-down: the advance completes INSIDE one event, rest accrues at 5%', () => {
    const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);
    let crossing: { eventId: string; recoupedBefore: number; producer: number; artist: number } | undefined;
    for (let n = 1; n <= 80 && !crossing; n++) {
      const eventId = `a-loop-${n}`;
      const occurredAt = new Date(Date.parse('2026-03-01T00:00:00Z') + n * 60_000).toISOString();
      const recoupedBefore = shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped') ?? 0;
      const res = single(processEvent(engine, graphA, depsA, royaltyEvent(eventId, occurredAt, 1_000_000_000)));
      const recoupedAfter = shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped') ?? 0;
      expect(entitlement(res, 'marketer')).toBe(40_000_000); // marketer still active (inside window)
      if (recoupedBefore < ADVANCE_MICROS && recoupedAfter === ADVANCE_MICROS) {
        crossing = {
          eventId,
          recoupedBefore,
          producer: entitlement(res, 'producer'),
          artist: entitlement(res, 'artist'),
        };
      }
    }
    expect(crossing).toBeDefined();
    const c = crossing!;

    // Recompute the expected producer amount from the OBSERVED pre-event
    // balance (independent of the engine's internals):
    //   need = advance - recoupedBefore
    //   take = min(pool after marketer, ceil(need / 20%))
    //   producer = min(round_half_up(take * 20%), need) + round_half_up((pool - take) * 5%)
    const poolAfterMarketer = 1_000_000_000 - 40_000_000; // 960_000_000
    const need = ADVANCE_MICROS - c.recoupedBefore;
    const take = Math.min(poolAfterMarketer, ceilDiv(need * 10000, 2000));
    const amtAtRecoupRate = Math.min(mulDivRoundHalfUp(take, 2000, 10000), need);
    const amtAtPostRate = mulDivRoundHalfUp(poolAfterMarketer - take, 500, 10000);
    expect(c.producer).toBe(amtAtRecoupRate + amtAtPostRate);
    expect(c.producer).toBeGreaterThan(0);
    expect(c.artist).toBe(poolAfterMarketer - (amtAtRecoupRate + amtAtPostRate));
    // The recouped balance lands EXACTLY on the advance — never over.
    expect(shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped')).toBe(ADVANCE_MICROS);

    // Sanity on the actual numbers: need was $16.00 -> take $80.00 of the
    // pool at 20% = $16.00 completing the advance, $880.00 of the pool at 5%
    // = $44.00 -> producer $60.00, artist $900.00.
    expect(c.recoupedBefore).toBe(9_984_000_000);
    expect(c.producer).toBe(60_000_000);
    expect(c.artist).toBe(900_000_000);
    assertLedgerLinkage(c.eventId, GRAPH_A);
  });

  it('after completion the producer pays a flat 5%', () => {
    const res = single(
      processEvent(engine, graphA, depsA, royaltyEvent('a-post', '2026-04-01T00:00:00Z', 1_000_000_000)),
    );
    expect(entitlement(res, 'producer')).toBe(48_000_000); // 5% of $960
    expect(entitlement(res, 'marketer')).toBe(40_000_000);
    expect(entitlement(res, 'artist')).toBe(912_000_000);
    // Recouped balance stays pinned at the advance (no over-recoupment).
    expect(shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped')).toBe(ADVANCE_MICROS);
  });

  it('expiry: marketer rule skipped past its window with a recorded reason', () => {
    const res = single(
      processEvent(
        engine,
        graphA,
        depsA,
        royaltyEvent('a-expiry', '2027-02-01T00:00:00Z', 5_000_000_000), // after effectiveTo
      ),
    );
    const skip = res.skipped.find((s) => s.ruleId === 'r-marketing');
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/outside effective window/);
    expect(skip!.reason).toContain(MARKETING_TO);
    // Skipped rule consumes nothing: producer 5% of the full $5,000 pool.
    expect(entitlement(res, 'producer')).toBe(250_000_000);
    expect(entitlement(res, 'artist')).toBe(4_750_000_000);
    expect(res.entitlements.some((e) => e.participantId === 'marketer')).toBe(false);
    // The skip is on the ledger with its reason.
    const skippedEntries = shared.ledger.entriesForEvent('a-expiry').filter((e) => e.type === 'SKIPPED');
    expect(skippedEntries.some((e) => e.ruleId === 'r-marketing' && /outside effective window/.test(e.reason))).toBe(true);
    assertLedgerLinkage('a-expiry', GRAPH_A);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION B — SaaS/marketplace
// ---------------------------------------------------------------------------

const GRAPH_B = 'graph-b';

const graphB: RevenueGraph = activateGraph(
  defineGraph({
    id: GRAPH_B,
    projectId: 'proj-b',
    ownerId: 'owner',
    participants: [
      participant('platform', 'company', ['platform'], 'ach', 'bank:platform-acct-3300'),
      participant('affiliate', 'person', ['referrer'], 'stripe', 'bank:affiliate-acct-5511'),
      participant('developer', 'person', ['contributor'], 'ach', 'bank:developer-acct-6644'),
      participant('owner', 'person', ['owner'], 'stripe', 'bank:owner-acct-9900'),
    ],
    revenueSources: [{ id: 'rs-b', kind: 'stripe', config: {}, eventTypes: ['SALE_COMPLETED'] }],
    rules: [
      { id: 'b-fee', type: 'payload_fee', priority: 0, params: { licenseTier: 'builder' } },
      { id: 'b-platform', type: 'platform_fee', priority: 10, params: { rateBps: 600, subjectParticipantId: 'platform' } },
      {
        id: 'b-referral',
        type: 'referral',
        priority: 20,
        params: { rateBps: 1000 }, // 10%
        conditions: { requireAttribution: true },
      },
      { id: 'b-dev', type: 'percentage', priority: 30, params: { rateBps: 500, subjectParticipantId: 'developer' } },
      { id: 'b-owner', type: 'remainder', priority: 100, params: { subjectParticipantId: 'owner' } },
    ] as Rule[],
  }),
);

const stripeB = createStripeAdapter({ graphId: GRAPH_B });

function stripeWebhook(paymentIntentId: string, referrerId?: string): Record<string, unknown> {
  const created = Math.floor(Date.parse('2026-02-15T12:00:00Z') / 1000); // fixed, deterministic
  const metadata: Record<string, string> = {};
  if (referrerId !== undefined) metadata['referrer_id'] = referrerId;
  return {
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: paymentIntentId,
        amount_received: 10000, // $100.00 in cents
        currency: 'usd',
        created,
        metadata,
      },
    },
  };
}

describe('Validation B — SaaS/marketplace (§7 walkthrough, executable)', () => {
  it('builds from a blank graph with generic primitives only; activates', () => {
    expect(graphB.status).toBe('active');
    expect(graphB.participants.map((p) => p.id).sort()).toEqual(['affiliate', 'developer', 'owner', 'platform']);
    expect(graphB.rules.map((r) => r.type).sort()).toEqual([
      'payload_fee',
      'percentage',
      'platform_fee',
      'referral',
      'remainder',
    ]);
  });

  it('B1: $100 Stripe payment_intent.succeeded via the Stripe adapter splits exactly', () => {
    // Adapter translation assertions (translation only — no evaluation here).
    const [translated] = stripeB.toEvents(stripeWebhook('pi_b1', 'affiliate'));
    const env = translated as EconomicEvent;
    expect(env.eventId).toBe('stripe_pi_b1');
    expect(env.type).toBe('SALE_COMPLETED');
    expect(env.amountMicros).toBe(100_000_000); // $100.00
    // Adapter default: 290bps + $0.30 -> round_half_up(100M * 290 / 10000) + 300k = 3_200_000.
    expect(env.processingCostMicros).toBe(3_200_000);
    expect(env.currency).toBe('USD');
    expect(env.rail).toBe('stripe');
    expect(env.attribution?.referrerId).toBe('affiliate');

    const res = single(processEvent(engine, graphB, depsB, { adapter: stripeB, raw: stripeWebhook('pi_b1', 'affiliate') }));
    expect(res.idempotentReplay).toBe(false);

    // net = $100.00 - $3.20 = $96.80 = 96_800_000. Builder tier (x0.8) on the
    // <=$10k volume tier (100bps) -> 80bps effective: 80bps x 96_800_000 = 774_400.
    expect(res.fees).toHaveLength(2); // payload_fee + platform_fee are both fees
    const payloadFee = res.fees.find((f) => f.kind === 'payload_fee')!;
    expect(payloadFee.amountMicros).toBe(774_400);
    expect(payloadFee.rateBps).toBe(80);
    expect(payloadFee.reason).toContain('80bps');
    const platformFee = res.fees.find((f) => f.kind === 'platform_fee')!;
    expect(platformFee.amountMicros).toBe(5_761_536);
    expect(platformFee.rateBps).toBe(600);
    expect(platformFee.reason).toContain('platform_fee 6.00%');

    // Priority-ordered pool consumption (round half up per computed amount):
    //   fee 774_400 ; pool 96_025_600
    //   platform 6% of 96_025_600 -> 5_761_536 ; pool 90_264_064
    //   affiliate 10% of 90_264_064 -> 9_026_406 (9_026_406.4 rounds down) ; pool 81_237_658
    //   developer 5% of 81_237_658 -> 4_061_883 (4_061_882.9 rounds up) ; pool 77_175_775
    //   owner remainder -> 77_175_775
    expect(feeAmount(res, 'payload_fee')).toBe(774_400);
    expect(feeAmount(res, 'platform_fee')).toBe(5_761_536);
    expect(entitlement(res, 'affiliate')).toBe(9_026_406);
    expect(entitlement(res, 'developer')).toBe(4_061_883);
    expect(entitlement(res, 'owner')).toBe(77_175_775);
    expect(
      entitlement(res, 'affiliate') +
        entitlement(res, 'developer') +
        entitlement(res, 'owner') +
        feeAmount(res, 'payload_fee') +
        feeAmount(res, 'platform_fee'),
    ).toBe(96_800_000); // pool conserved exactly

    const reasons = new Map(res.entitlements.map((e) => [e.participantId, e.reason]));
    expect(reasons.get('affiliate')).toContain("referrer 'affiliate'");
    expect(reasons.get('owner')).toBe('remainder of pool -> $77.17');

    assertLedgerLinkage('stripe_pi_b1', GRAPH_B);
  });

  it('B2: no attribution claim -> referral rule skipped with a recorded reason; owner absorbs', () => {
    const res = single(processEvent(engine, graphB, depsB, { adapter: stripeB, raw: stripeWebhook('pi_b2') }));
    expect(res.idempotentReplay).toBe(false); // second transaction, automatic, no reconfiguration

    const skip = res.skipped.find((s) => s.ruleId === 'b-referral');
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/no referrer claim/);

    expect(feeAmount(res, 'payload_fee')).toBe(774_400); // same deterministic math on the second event
    expect(feeAmount(res, 'platform_fee')).toBe(5_761_536);
    expect(res.entitlements.some((e) => e.participantId === 'affiliate')).toBe(false);
    // Skipped rules consume NOTHING, so later rules compute on the unreduced
    // pool: developer 5% of 90_264_064 = 4_513_203 (4_513_203.2 rounds down),
    // and the remainder takes the rest: 90_264_064 - 4_513_203 = 85_750_861.
    // (This differs from the task brief's 86_202_181/4_061_883 because those
    // figures assumed the developer still computed on the referral-reduced
    // pool; the engine's documented sequential-consumption semantics say the
    // developer — priority 30, after the skipped referral at priority 20 —
    // computes on the pool the referral left untouched. Recorded in
    // ACCEPTANCE.md as a §7-deviation.)
    expect(entitlement(res, 'developer')).toBe(4_513_203);
    expect(entitlement(res, 'owner')).toBe(85_750_861);
    expect(
      entitlement(res, 'developer') + entitlement(res, 'owner') + feeAmount(res, 'payload_fee') + feeAmount(res, 'platform_fee'),
    ).toBe(96_800_000); // pool conserved exactly

    // The skip is on the ledger with its reason (inspectability).
    const skippedEntries = shared.ledger.entriesForEvent('stripe_pi_b2').filter((e) => e.type === 'SKIPPED');
    expect(skippedEntries.some((e) => e.ruleId === 'b-referral' && /no referrer claim/.test(e.reason))).toBe(true);
    assertLedgerLinkage('stripe_pi_b2', GRAPH_B);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION C — machine commerce
// ---------------------------------------------------------------------------

// Free tier on 'acct-c' with the $1,000 lifetime allowance PRE-EXHAUSTED so
// the fee is nonzero and deterministic (100bps of net, x402 rail floor $0).
shared.feeEngine.recordVolume('acct-c', '2026-01-05T00:00:00Z', 1_000_000_000);

const GRAPH_C = 'graph-c';

const graphC: RevenueGraph = activateGraph(
  defineGraph({
    id: GRAPH_C,
    projectId: 'proj-c',
    ownerId: 'operator',
    participants: [
      participant('developer', 'person', ['contributor'], 'ach', 'bank:developer-acct-2210'),
      // The referring agent is a first-class Participant of kind 'agent' with
      // an x402 wallet destination. NOTE: no engine branching on kind
      // anywhere — the agent flows through the exact same referral-rule code
      // path as a human referrer; only the destination rail differs.
      participant('referring-agent', 'agent', ['referrer'], 'x402', '0x742d35Cc6634C0532925a3b844Bc9e7595f2fE'),
      participant('operator', 'company', ['owner'], 'ach', 'bank:operator-acct-7788'),
    ],
    revenueSources: [{ id: 'rs-c', kind: 'x402', config: {}, eventTypes: ['API_PAYMENT'] }],
    rules: [
      { id: 'c-fee', type: 'payload_fee', priority: 0, params: { licenseTier: 'free' } },
      {
        id: 'c-peruse',
        type: 'per_use',
        priority: 10,
        params: { rateMicrosPerUnit: 2000, subjectParticipantId: 'developer' }, // $0.002/unit
      },
      {
        id: 'c-referral',
        type: 'referral',
        priority: 20,
        params: { rateBps: 1000 }, // 10%
        conditions: { requireAttribution: true },
      },
      { id: 'c-operator', type: 'remainder', priority: 100, params: { subjectParticipantId: 'operator' } },
    ] as Rule[],
  }),
);

// Fixed settledAt (no wall-clock assertions) with a long maxAgeMs so the
// adapter's freshness guard is satisfied deterministically.
const x402C = createX402Adapter({
  graphId: GRAPH_C,
  assetCode: 'USDC',
  processingCostMicros: 2000,
  maxAgeMs: 10 * 365 * 24 * 3600 * 1000,
});

function settleConfirmation(txHash: string, settledAt: string, referrerId?: string): Record<string, unknown> {
  const c: Record<string, unknown> = {
    txHash,
    network: 'eip155:8453',
    asset: '0xUSDCBaseContract',
    amountMicros: 100_000, // $0.10
    payTo: '0xOperatorTreasury',
    settledAt,
    usageUnits: 1,
  };
  if (referrerId !== undefined) c['attribution'] = { referrerId };
  return c;
}

describe('Validation C — machine commerce (§7 walkthrough, executable)', () => {
  it('builds from a blank graph with generic primitives only; activates', () => {
    expect(graphC.status).toBe('active');
    expect(graphC.participants.map((p) => p.id).sort()).toEqual(['developer', 'operator', 'referring-agent']);
    const agent = graphC.participants.find((p) => p.id === 'referring-agent')!;
    expect(agent.kind).toBe('agent');
    expect(agent.payoutDestinations[0]!.rail).toBe('x402');
  });

  it('C1: $0.10 x402 settle confirmation splits exactly; agent routes to its wallet', () => {
    const [translated] = x402C.toEvents(settleConfirmation('0xabc123def456', '2026-02-01T00:00:00Z', 'referring-agent'));
    const env = translated as EconomicEvent;
    expect(env.eventId).toBe('x402_0xabc123def456');
    expect(env.type).toBe('API_PAYMENT');
    expect(env.amountMicros).toBe(100_000);
    expect(env.processingCostMicros).toBe(2000);
    expect(env.currency).toBe('USDC');
    expect(env.rail).toBe('x402');
    expect(env.usageUnits).toBe(1);
    expect(env.attribution?.referrerId).toBe('referring-agent');

    const res = single(
      processEvent(engine, graphC, depsC, {
        adapter: x402C,
        raw: settleConfirmation('0xabc123def456', '2026-02-01T00:00:00Z', 'referring-agent'),
      }),
    );
    expect(res.idempotentReplay).toBe(false);

    // net = $0.10 - $0.002 = $0.098 = 98_000. Free tier, allowance exhausted:
    // fee = max(x402 floor $0, 100bps x 98_000) = 980.
    const fee = res.fees[0]!;
    expect(res.fees).toHaveLength(1);
    expect(fee.kind).toBe('payload_fee');
    expect(fee.amountMicros).toBe(980);
    expect(fee.rateBps).toBe(100);

    // Priority-ordered pool consumption:
    //   pool after fee: 97_020
    //   developer per_use: 2_000 x 1 = 2_000 ; remainder 95_020
    //   agent referral 10%: 9_502 ; remainder 85_518
    //   operator remainder: 85_518
    expect(entitlement(res, 'developer')).toBe(2000);
    expect(entitlement(res, 'referring-agent')).toBe(9502);
    expect(entitlement(res, 'operator')).toBe(85_518);
    expect(
      entitlement(res, 'developer') + entitlement(res, 'referring-agent') + entitlement(res, 'operator') + fee.amountMicros,
    ).toBe(98_000); // pool conserved exactly

    // The agent's instruction routes to its x402 wallet, and NOTHING executes:
    // every distribution is a 'proposed' instruction only (no-custody).
    const agentDist = res.distributions.find((d) => d.participantId === 'referring-agent')!;
    expect(agentDist.destination.rail).toBe('x402');
    expect(agentDist.destination.address).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f2fE');
    expect(agentDist.amountMicros).toBe(9502);
    for (const d of res.distributions) {
      expect(d.status).toBe('proposed');
      expect(d.eventId).toBe('x402_0xabc123def456');
    }

    assertLedgerLinkage('x402_0xabc123def456', GRAPH_C);
  });

  it('redelivery of the same confirmation is an idempotent replay: no new entries, state unchanged', () => {
    const beforeEntries = shared.ledger.entriesForEvent('x402_0xabc123def456').length;
    const beforeVolume = volumeTracker.lifetimeNetMicros('acct-c');
    const res = single(
      processEvent(engine, graphC, depsC, {
        adapter: x402C,
        raw: settleConfirmation('0xabc123def456', '2026-02-01T00:00:00Z', 'referring-agent'),
      }),
    );
    expect(res.idempotentReplay).toBe(true);
    expect(shared.ledger.entriesForEvent('x402_0xabc123def456').length).toBe(beforeEntries);
    expect(volumeTracker.lifetimeNetMicros('acct-c')).toBe(beforeVolume); // no double-count
    // The replayed result still carries the prior entitlements (no recomputation).
    expect(entitlement(res, 'referring-agent')).toBe(9502);
  });

  it('a new txHash is a new transaction: automatic, no reconfiguration', () => {
    const res = single(
      processEvent(engine, graphC, depsC, {
        adapter: x402C,
        raw: settleConfirmation('0xdef789abc012', '2026-02-01T01:00:00Z', 'referring-agent'),
      }),
    );
    expect(res.idempotentReplay).toBe(false);
    expect(res.eventId).toBe('x402_0xdef789abc012');
    expect(res.fees[0]!.amountMicros).toBe(980);
    expect(entitlement(res, 'developer')).toBe(2000);
    expect(entitlement(res, 'referring-agent')).toBe(9502);
    expect(entitlement(res, 'operator')).toBe(85_518);
    assertLedgerLinkage('x402_0xdef789abc012', GRAPH_C);
  });

  it('no attribution claim -> referral rule skipped with a recorded reason; operator absorbs', () => {
    const res = single(
      processEvent(engine, graphC, depsC, {
        adapter: x402C,
        raw: settleConfirmation('0xnoattr345678', '2026-02-01T02:00:00Z'),
      }),
    );
    const skip = res.skipped.find((s) => s.ruleId === 'c-referral');
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/no referrer claim/);
    expect(entitlement(res, 'developer')).toBe(2000);
    expect(res.entitlements.some((e) => e.participantId === 'referring-agent')).toBe(false);
    // 97_020 - 2_000 = 95_020 falls through to the remainder.
    expect(entitlement(res, 'operator')).toBe(95_020);
    expect(res.fees[0]!.amountMicros).toBe(980);
    expect(entitlement(res, 'developer') + entitlement(res, 'operator') + res.fees[0]!.amountMicros).toBe(98_000);
    assertLedgerLinkage('x402_0xnoattr345678', GRAPH_C);
  });
});

// ---------------------------------------------------------------------------
// CROSS-PROOF (§14): all three graphs, one Rail deployment, one run
// ---------------------------------------------------------------------------

describe('Cross-proof — one Rail deployment evaluates all three graphs', () => {
  it('the shared ledger holds entries for all three graphs and the chain verifies', () => {
    expect(shared.ledger.entriesForGraph(GRAPH_A).length).toBeGreaterThan(0);
    expect(shared.ledger.entriesForGraph(GRAPH_B).length).toBeGreaterThan(0);
    expect(shared.ledger.entriesForGraph(GRAPH_C).length).toBeGreaterThan(0);
    expect(shared.ledger.verifyChain()).toBe(true);
  });

  it('state is per graphId: graphs do not interfere', () => {
    expect(shared.stateStore.get(GRAPH_A, RECOUP_RULE_A, 'producer', 'recouped')).toBe(ADVANCE_MICROS);
    expect(shared.stateStore.get(GRAPH_B, RECOUP_RULE_A, 'producer', 'recouped')).toBeUndefined();
    expect(shared.stateStore.get(GRAPH_C, RECOUP_RULE_A, 'producer', 'recouped')).toBeUndefined();
  });

  it('volume is per accountId: the shared fee engine stays deterministic per validation', () => {
    // B: two $96.80-net events on acct-b.
    expect(volumeTracker.lifetimeNetMicros('acct-b')).toBe(2 * 96_800_000);
    // C: $1,000 pre-exhaustion + three $0.098-net events (redelivery recorded nothing).
    expect(volumeTracker.lifetimeNetMicros('acct-c')).toBe(1_000_000_000 + 3 * 98_000);
  });
});
