/**
 * engine.test.ts — PayloadEvaluationEngine unit tests.
 *
 * Covers: rule priority order, sequential pool consumption, recoupment
 * statefulness across events, idempotency, cap flip, mid-event step-down,
 * time-window expiry, conditional referral skip, milestone gating, remainder
 * conservation, graph validation errors, the approval gate, simulate() purity,
 * attribution determination, and event envelope validation.
 */
import { describe, expect, it } from 'vitest';
import { PayloadEvaluationEngine } from '../src/engine.js';
import { InMemoryEventStore } from '../src/event-store.js';
import { InMemoryStateStore } from '../src/state-store.js';
import { InMemoryLedger } from '../src/ledger.js';
import { validateGraph } from '../src/rules.js';
import { approveRuleChange, proposeRuleChange } from '../src/graph.js';
import { validateEvent } from '../src/events.js';
import type {
  EconomicEvent,
  EngineDeps,
  FeeEngine,
  License,
  LicenseTier,
  Participant,
  Rail,
  RevenueGraph,
  Rule,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic stub fee engine: 100bps of net, rail floors per §12. */
class StubFeeEngine implements FeeEngine {
  volumeRecords: Array<{ accountId: string; at: string; netMicros: number }> = [];

  computeFee(args: {
    amountMicros: number;
    processingCostMicros: number;
    rail: Rail;
    accountId: string;
    license: License;
    at: string;
  }): { feeMicros: number; rateBps: number; netMicros: number; tier: LicenseTier } {
    const net = Math.max(0, args.amountMicros - args.processingCostMicros);
    const floor = args.rail === 'stripe' ? 10_000 : 0; // $0.01
    const fee = Math.max(floor, Math.round((net * 100) / 10000));
    return { feeMicros: fee, rateBps: 100, netMicros: net, tier: args.license.tier };
  }

  recordVolume(accountId: string, at: string, netMicros: number): void {
    this.volumeRecords.push({ accountId, at, netMicros });
  }
}

function participant(id: string, rail: Rail = 'stripe'): Participant {
  return {
    id,
    kind: 'person',
    roles: ['contributor'],
    payoutDestinations: [{ rail, address: `addr_${id}` }],
  };
}

function makeDeps() {
  const eventStore = new InMemoryEventStore();
  const stateStore = new InMemoryStateStore();
  const ledger = new InMemoryLedger();
  const feeEngine = new StubFeeEngine();
  const accounting = {
    accountId: 'acct_1',
    license: { accountId: 'acct_1', tier: 'pro' as LicenseTier, grantedAt: '2026-01-01T00:00:00.000Z' },
  };
  const deps: EngineDeps = { eventStore, stateStore, ledger, feeEngine, accounting };
  const engine = new PayloadEvaluationEngine(deps);
  return { eventStore, stateStore, ledger, feeEngine, accounting, deps, engine };
}

function makeGraph(rules: Rule[], participants: Participant[], id = 'g1'): RevenueGraph {
  return {
    id,
    projectId: 'p1',
    version: 1,
    status: 'active',
    participants,
    revenueSources: [],
    rules,
    versions: [],
  };
}

function makeEvent(overrides: Partial<EconomicEvent> = {}): EconomicEvent {
  return {
    eventId: 'e1',
    graphId: 'g1',
    type: 'SALE_COMPLETED',
    occurredAt: '2026-10-03T12:00:00.000Z',
    amountMicros: 100_000_000, // $100.00
    currency: 'USD',
    rail: 'stripe',
    processingCostMicros: 3_300_000, // $3.30 -> pool $96.70
    raw: {},
    ...overrides,
  };
}

const POOL = 96_700_000; // $96.70

const pct = (id: string, priority: number, rateBps: number, subject: string): Rule => ({
  id,
  type: 'percentage',
  priority,
  params: { rateBps, subjectParticipantId: subject },
});
const remainder = (id: string, priority: number, subject: string): Rule => ({
  id,
  type: 'remainder',
  priority,
  params: { subjectParticipantId: subject },
});

// ---------------------------------------------------------------------------
// Core evaluation semantics
// ---------------------------------------------------------------------------

describe('evaluation order and pool consumption', () => {
  it('evaluates in priority order and consumes the pool sequentially', () => {
    const { engine, deps } = makeDeps();
    const graph = makeGraph(
      [
        { id: 'r_fixed', type: 'fixed', priority: 1, params: { amountMicros: 10_000_000, subjectParticipantId: 'alice' } },
        pct('r_pct', 2, 5000, 'bob'),
        remainder('r_rem', 3, 'owner'),
      ],
      [participant('alice'), participant('bob'), participant('owner')],
    );
    const result = engine.evaluate(graph, makeEvent(), deps);
    expect(result.idempotentReplay).toBe(false);
    expect(result.graphVersion).toBe(1);
    // fixed $10 first: pool 96.7M -> 86.7M; 50% of 86.7M = 43.35M; remainder 43.35M
    expect(result.entitlements.map((e) => [e.ruleId, e.amountMicros])).toEqual([
      ['r_fixed', 10_000_000],
      ['r_pct', 43_350_000],
      ['r_rem', 43_350_000],
    ]);
    // distributions are proposed instructions, never executions
    expect(result.distributions).toHaveLength(3);
    for (const d of result.distributions) {
      expect(d.status).toBe('proposed');
      expect(d.instructionId).toMatch(/^dist:e1:/);
      expect(d.currency).toBe('USD');
    }
  });

  it('breaks priority ties deterministically by rule id', () => {
    const { engine, deps } = makeDeps();
    const graph = makeGraph(
      [
        pct('r_b', 1, 1000, 'bob'),
        pct('r_a', 1, 1000, 'alice'),
        remainder('r_rem', 2, 'owner'),
      ],
      [participant('alice'), participant('bob'), participant('owner')],
    );
    const result = engine.evaluate(graph, makeEvent(), deps);
    // r_a sorts before r_b on equal priority
    expect(result.entitlements[0]!.ruleId).toBe('r_a');
    expect(result.entitlements[1]!.ruleId).toBe('r_b');
    expect(result.entitlements[0]!.amountMicros).toBe(9_670_000); // 10% of 96.7M
    expect(result.entitlements[1]!.amountMicros).toBe(8_703_000); // 10% of 87.03M
  });
});

describe('recoupment statefulness', () => {
  const recoupGraph = () =>
    makeGraph(
      [
        {
          id: 'recoup',
          type: 'recoupment',
          priority: 1,
          params: {
            subjectParticipantId: 'artist',
            advanceMicros: 10_000_000, // $10 advance
            recoupRateBps: 2000, // 20%
            postRateBps: 500, // 5%
          },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('artist'), participant('owner')],
    );

  it('persists the recoupment balance across events', () => {
    const { engine, deps, stateStore } = makeDeps();
    const graph = recoupGraph();
    // Event 1: pool 96.7M. need=10M -> take=min(96.7M, ceil(10M*10000/2000)=50M)=50M.
    // amt1 = 50M*20% = 10M (advance complete); amt2 = 46.7M*5% = 2.335M.
    const r1 = engine.evaluate(graph, makeEvent({ eventId: 'e1' }), deps);
    expect(r1.entitlements[0]!.amountMicros).toBe(12_335_000);
    expect(stateStore.get('g1', 'recoup', 'artist', 'recouped')).toBe(10_000_000);
    // Event 2: advance fully recouped -> everything at the 5% post rate.
    const r2 = engine.evaluate(graph, makeEvent({ eventId: 'e2' }), deps);
    expect(r2.entitlements[0]!.amountMicros).toBe(4_835_000); // 5% of 96.7M
    expect(stateStore.get('g1', 'recoup', 'artist', 'recouped')).toBe(10_000_000);
    expect(r2.entitlements[1]!.amountMicros).toBe(91_865_000);
  });

  it('steps down mid-event (validation A walkthrough)', () => {
    const { engine, deps, stateStore } = makeDeps();
    const graph = makeGraph(
      [
        {
          id: 'recoup',
          type: 'recoupment',
          priority: 1,
          params: {
            subjectParticipantId: 'artist',
            advanceMicros: 10_000_000_000, // $10,000 advance
            recoupRateBps: 2000,
            postRateBps: 500,
          },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('artist'), participant('owner')],
    );
    stateStore.set('g1', 'recoup', 'artist', 'recouped', 9_950_000_000); // $9,950 already recouped
    // $50,000 event: $50 completes the advance at 20% (take=250M), then 5% on the rest.
    const r = engine.evaluate(graph, makeEvent({ eventId: 'e1', amountMicros: 50_000_000_000, processingCostMicros: 0 }), deps);
    expect(r.entitlements[0]!.amountMicros).toBe(2_537_500_000); // $50 + $2,487.50
    expect(stateStore.get('g1', 'recoup', 'artist', 'recouped')).toBe(10_000_000_000);
  });
});

describe('idempotency', () => {
  it('re-delivery returns the prior result with zero side effects', () => {
    const { engine, deps, ledger, stateStore, feeEngine } = makeDeps();
    const graph = makeGraph(
      [
        pct('r_pct', 1, 1000, 'alice'),
        { id: 'r_fee', type: 'payload_fee', priority: 2, params: { licenseTier: 'pro' as LicenseTier } },
        remainder('r_rem', 3, 'owner'),
      ],
      [participant('alice'), participant('owner')],
    );
    const event = makeEvent();
    const first = engine.evaluate(graph, event, deps);
    expect(first.idempotentReplay).toBe(false);
    const entriesAfterFirst = ledger.entries().length;
    const volumeAfterFirst = feeEngine.volumeRecords.length;

    const replay = engine.evaluate(graph, makeEvent(), deps);
    expect(replay.idempotentReplay).toBe(true);
    expect({ ...replay, idempotentReplay: false }).toEqual(first);
    expect(ledger.entries().length).toBe(entriesAfterFirst); // no new ledger entries
    expect(feeEngine.volumeRecords.length).toBe(volumeAfterFirst); // no double volume
    expect(stateStore.size()).toBe(0); // no state touched by these rules anyway
  });
});

describe('capped rules', () => {
  it('flips to a skip with reason once the cap is exhausted', () => {
    const { engine, deps, ledger } = makeDeps();
    const graph = makeGraph(
      [
        {
          id: 'cap1',
          type: 'capped',
          priority: 1,
          params: {
            inner: { id: 'cap1_inner', type: 'percentage', priority: 1, params: { rateBps: 5000, subjectParticipantId: 'bob' } },
            capMicros: 5_000_000,
            subjectParticipantId: 'bob',
          },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('bob'), participant('owner')],
    );
    const r1 = engine.evaluate(graph, makeEvent({ eventId: 'e1' }), deps);
    expect(r1.entitlements[0]!.amountMicros).toBe(5_000_000); // inner wanted 48.35M
    const r2 = engine.evaluate(graph, makeEvent({ eventId: 'e2' }), deps);
    expect(r2.skipped).toHaveLength(1);
    expect(r2.skipped[0]!.ruleId).toBe('cap1');
    expect(r2.skipped[0]!.reason).toMatch(/cap reached/i);
    expect(r2.entitlements[0]!.amountMicros).toBe(POOL); // remainder absorbs everything
    const skipEntries = ledger.entriesForEvent('e2').filter((e) => e.type === 'SKIPPED');
    expect(skipEntries).toHaveLength(1);
    expect(skipEntries[0]!.reason).toMatch(/cap reached/i);
  });
});

describe('time-limited rules', () => {
  it('skips with a reason outside the effective window', () => {
    const { engine, deps } = makeDeps();
    const graph = makeGraph(
      [
        {
          id: 'tl',
          type: 'time_limited',
          priority: 1,
          params: {
            inner: { id: 'tl_inner', type: 'percentage', priority: 1, params: { rateBps: 1000, subjectParticipantId: 'alice' } },
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: '2026-02-01T00:00:00.000Z',
          },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('alice'), participant('owner')],
    );
    const r = engine.evaluate(graph, makeEvent(), deps);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toMatch(/effective window/);
    expect(r.entitlements[0]!.amountMicros).toBe(POOL);
  });
});

describe('referral rules', () => {
  const referralGraph = () =>
    makeGraph(
      [{ id: 'ref1', type: 'referral', priority: 1, params: { rateBps: 1000 } }, remainder('rem', 2, 'owner')],
      [participant('refp'), participant('owner')],
    );

  it('skips without attribution (requireAttribution defaults true)', () => {
    const { engine, deps } = makeDeps();
    const r = engine.evaluate(referralGraph(), makeEvent(), deps);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.ruleId).toBe('ref1');
    expect(r.skipped[0]!.reason).toMatch(/attribution/);
    expect(r.entitlements[0]!.amountMicros).toBe(POOL);
  });

  it('pays the attributed referrer when present', () => {
    const { engine, deps } = makeDeps();
    const r = engine.evaluate(
      referralGraph(),
      makeEvent({ attribution: { referrerId: 'refp' } }),
      deps,
    );
    expect(r.skipped).toHaveLength(0);
    expect(r.entitlements[0]!.participantId).toBe('refp');
    expect(r.entitlements[0]!.amountMicros).toBe(9_670_000);
  });

  it('skips when the attributed referrer is not a participant', () => {
    const { engine, deps } = makeDeps();
    const r = engine.evaluate(
      referralGraph(),
      makeEvent({ attribution: { referrerId: 'stranger' } }),
      deps,
    );
    expect(r.skipped[0]!.reason).toMatch(/not a participant/);
  });
});

describe('milestone rules', () => {
  const milestoneGraph = () =>
    makeGraph(
      [
        {
          id: 'm1',
          type: 'milestone',
          priority: 1,
          params: {
            inner: { id: 'm1_inner', type: 'percentage', priority: 1, params: { rateBps: 1000, subjectParticipantId: 'alice' } },
            trigger: 'manual',
            description: 'test milestone',
          },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('alice'), participant('owner')],
    );

  it('stays dormant until triggered, then activates', () => {
    const { engine, deps } = makeDeps();
    const graph = milestoneGraph();
    const before = engine.evaluate(graph, makeEvent({ eventId: 'e1' }), deps);
    expect(before.skipped[0]!.reason).toMatch(/not been triggered/);
    expect(before.entitlements[0]!.amountMicros).toBe(POOL);

    engine.triggerMilestone(graph, 'm1', 'owner');
    const after = engine.evaluate(graph, makeEvent({ eventId: 'e2' }), deps);
    expect(after.skipped).toHaveLength(0);
    expect(after.entitlements[0]!.participantId).toBe('alice');
    expect(after.entitlements[0]!.amountMicros).toBe(9_670_000);
  });

  it('throws when triggering a non-milestone rule', () => {
    const { engine, deps } = makeDeps();
    const graph = milestoneGraph();
    expect(() => engine.triggerMilestone(graph, 'rem', 'owner')).toThrow(/not 'milestone'/);
    expect(() => engine.triggerMilestone(graph, 'nope', 'owner')).toThrow(/has no rule/);
    void deps;
  });
});

describe('remainder conservation', () => {
  it('allocations + fees sum exactly to the pool', () => {
    const { engine, deps } = makeDeps();
    const graph = makeGraph(
      [
        { id: 'plat', type: 'platform_fee', priority: 1, params: { rateBps: 600, subjectParticipantId: 'owner' } },
        pct('r_pct', 2, 1000, 'alice'),
        { id: 'pfee', type: 'payload_fee', priority: 3, params: { licenseTier: 'pro' as LicenseTier } },
        { id: 'r_fixed', type: 'fixed', priority: 4, params: { amountMicros: 1_000_000, subjectParticipantId: 'bob' } },
        remainder('r_rem', 5, 'owner'),
      ],
      [participant('alice'), participant('bob'), participant('owner')],
    );
    const r = engine.evaluate(graph, makeEvent(), deps);
    // platform 6% of 96.7M = 5.802M; 10% of 90.898M = 9.0898M; payload fee 967k; fixed 1M
    expect(r.fees.map((f) => [f.kind, f.amountMicros])).toEqual([
      ['platform_fee', 5_802_000],
      ['payload_fee', 967_000],
    ]);
    const total =
      r.entitlements.reduce((s, e) => s + e.amountMicros, 0) + r.fees.reduce((s, f) => s + f.amountMicros, 0);
    expect(total).toBe(POOL);
    expect(r.entitlements[r.entitlements.length - 1]!.ruleId).toBe('r_rem');
    expect(r.entitlements[r.entitlements.length - 1]!.amountMicros).toBe(79_841_200);
  });
});

describe('simulate()', () => {
  it('computes identically with zero side effects', () => {
    const { engine, deps, ledger, stateStore, eventStore, feeEngine } = makeDeps();
    const graph = makeGraph(
      [pct('r_pct', 1, 1000, 'alice'), remainder('r_rem', 2, 'owner')],
      [participant('alice'), participant('owner')],
    );
    const sim = engine.simulate(graph, makeEvent(), deps);
    expect(sim.idempotentReplay).toBe(false);
    expect(sim.entitlements.map((e) => e.amountMicros)).toEqual([9_670_000, 87_030_000]);
    // Zero side effects:
    expect(ledger.entries()).toHaveLength(0);
    expect(stateStore.size()).toBe(0);
    expect(eventStore.getEvent('e1')).toBeUndefined();
    expect(feeEngine.volumeRecords).toHaveLength(0);

    // A real evaluation afterwards works and matches the simulation.
    const real = engine.evaluate(graph, makeEvent(), deps);
    expect(real.entitlements).toEqual(sim.entitlements);
    expect(ledger.entries().length).toBeGreaterThan(0);
  });

  it('does not mutate recoupment state', () => {
    const { engine, deps, stateStore } = makeDeps();
    const graph = makeGraph(
      [
        {
          id: 'recoup',
          type: 'recoupment',
          priority: 1,
          params: { subjectParticipantId: 'artist', advanceMicros: 10_000_000, recoupRateBps: 2000, postRateBps: 500 },
        },
        remainder('rem', 2, 'owner'),
      ],
      [participant('artist'), participant('owner')],
    );
    engine.simulate(graph, makeEvent(), deps);
    expect(stateStore.get('g1', 'recoup', 'artist', 'recouped')).toBeUndefined();
  });

  it('returns the prior result when simulating an already-processed event', () => {
    const { engine, deps, ledger, feeEngine } = makeDeps();
    const graph = makeGraph(
      [pct('r_pct', 1, 1000, 'alice'), remainder('r_rem', 2, 'owner')],
      [participant('alice'), participant('owner')],
    );
    const real = engine.evaluate(graph, makeEvent(), deps);
    const entriesAfterReal = ledger.entries().length;
    const sim = engine.simulate(graph, makeEvent(), deps);
    expect(sim.idempotentReplay).toBe(true);
    expect({ ...sim, idempotentReplay: false }).toEqual(real);
    expect(ledger.entries().length).toBe(entriesAfterReal);
    expect(feeEngine.volumeRecords).toHaveLength(1);
  });
});

describe('attribution rules', () => {
  function touchedDeps() {
    const d = makeDeps();
    d.eventStore.appendTouch({
      eventId: 't1', graphId: 'g1', occurredAt: '2026-10-03T10:00:00.000Z', referrerId: 'refA', raw: {},
    });
    d.eventStore.appendTouch({
      eventId: 't2', graphId: 'g1', occurredAt: '2026-10-03T11:00:00.000Z', referrerId: 'refB', raw: {},
    });
    return d;
  }
  const attrGraph = (model: 'first_touch' | 'last_touch') =>
    makeGraph(
      [{ id: 'attr', type: 'attribution', priority: 1, params: { model, windowDays: 1, rateBps: 1000 } }, remainder('rem', 2, 'owner')],
      [participant('refA'), participant('refB'), participant('owner')],
    );

  it('first_touch pays the earliest referrer and names the touch event', () => {
    const { engine, deps } = touchedDeps();
    const r = engine.evaluate(attrGraph('first_touch'), makeEvent(), deps);
    expect(r.entitlements[0]!.participantId).toBe('refA');
    expect(r.entitlements[0]!.amountMicros).toBe(9_670_000);
    expect(r.entitlements[0]!.reason).toContain("touch 't1'");
  });

  it('last_touch pays the latest referrer', () => {
    const { engine, deps } = touchedDeps();
    const r = engine.evaluate(attrGraph('last_touch'), makeEvent(), deps);
    expect(r.entitlements[0]!.participantId).toBe('refB');
  });

  it('skips with a reason when no touch is found in the window', () => {
    const { engine, deps } = makeDeps();
    const r = engine.evaluate(attrGraph('first_touch'), makeEvent(), deps);
    expect(r.skipped[0]!.reason).toMatch(/no touch events found/);
    expect(r.entitlements[0]!.amountMicros).toBe(POOL);
  });
});

describe('waterfall expansion', () => {
  it('expands tranches into ordered percentage rules in the waterfall slot', () => {
    const { engine, deps } = makeDeps();
    const graph = makeGraph(
      [
        pct('early', 1, 1000, 'alice'),
        {
          id: 'wf',
          type: 'waterfall',
          priority: 5,
          params: {
            tranches: [
              { subjectParticipantId: 'bob', rateBps: 5000, upToMicros: 20_000_000 },
              { subjectParticipantId: 'carol', rateBps: 3000 },
            ],
          },
        },
        remainder('rem', 9, 'owner'),
      ],
      [participant('alice'), participant('bob'), participant('carol'), participant('owner')],
    );
    const r = engine.evaluate(graph, makeEvent(), deps);
    // early: 10% of 96.7M = 9.67M -> 87.03M left
    // tranche0: 50% of 87.03M = 43.515M, capped at 20M -> 20M -> 67.03M left
    // tranche1: 30% of 67.03M = 20.109M -> 46.921M left
    // remainder: 46.921M
    expect(r.entitlements.map((e) => [e.ruleId, e.amountMicros])).toEqual([
      ['early', 9_670_000],
      ['wf#tranche0', 20_000_000],
      ['wf#tranche1', 20_109_000],
      ['rem', 46_921_000],
    ]);
  });
});

describe('graph validation errors', () => {
  const parts = [participant('alice'), participant('owner')];

  it('rejects two remainder rules', () => {
    const errors = validateGraph(makeGraph([remainder('r1', 2, 'owner'), remainder('r2', 3, 'owner')], parts));
    expect(errors.some((e) => e.includes('exactly one'))).toBe(true);
  });

  it('rejects a remainder that is not the lowest priority', () => {
    const errors = validateGraph(makeGraph([remainder('r1', 1, 'owner'), pct('p1', 2, 1000, 'alice')], parts));
    expect(errors.some((e) => e.includes('lowest priority'))).toBe(true);
  });

  it('rejects unknown subject participants', () => {
    const errors = validateGraph(makeGraph([pct('p1', 1, 1000, 'ghost'), remainder('r1', 2, 'owner')], parts));
    expect(errors.some((e) => e.includes("'ghost'"))).toBe(true);
  });

  it('rejects duplicate rule ids', () => {
    const errors = validateGraph(makeGraph([pct('p1', 1, 1000, 'alice'), pct('p1', 2, 1000, 'alice'), remainder('r1', 3, 'owner')], parts));
    expect(errors.some((e) => e.includes('duplicate rule id'))).toBe(true);
  });

  it('accepts a valid graph (empty error list)', () => {
    const errors = validateGraph(makeGraph([pct('p1', 1, 1000, 'alice'), remainder('r1', 2, 'owner')], parts));
    expect(errors).toEqual([]);
  });

  it('engine refuses to evaluate an invalid graph or a non-active graph', () => {
    const { engine, deps } = makeDeps();
    const bad = makeGraph([remainder('r1', 2, 'owner'), remainder('r2', 3, 'owner')], parts);
    expect(() => engine.evaluate(bad, makeEvent(), deps)).toThrow(/invalid revenue graph/);
    const draft = { ...makeGraph([remainder('r1', 2, 'owner')], parts), status: 'draft' as const };
    expect(() => engine.evaluate(draft, makeEvent(), deps)).toThrow(/only 'active' graphs/);
  });
});

describe('approval gate', () => {
  const v1Rules = [pct('p1', 1, 1000, 'alice'), remainder('r1', 2, 'owner')];
  const v2Rules = [pct('p1', 1, 2000, 'alice'), remainder('r1', 2, 'owner')];
  const parts = [participant('alice'), participant('owner')];

  it('propose() stages a pending change without activating it', () => {
    const graph = makeGraph(v1Rules, parts);
    proposeRuleChange(graph, 'owner', v2Rules, 'raise alice');
    expect(graph.version).toBe(1);
    expect(graph.rules).toBe(v1Rules); // untouched
    expect(graph.pendingChange?.proposedBy).toBe('owner');
    expect(graph.pendingChange?.note).toBe('raise alice');
  });

  it('approve() throws for a non-owner and activates for the owner', () => {
    const graph = makeGraph(v1Rules, parts);
    proposeRuleChange(graph, 'owner', v2Rules);
    expect(() => approveRuleChange(graph, 'mallory', 'owner')).toThrow(/not the project owner/);
    expect(graph.version).toBe(1); // still not activated
    const v = approveRuleChange(graph, 'owner', 'owner');
    expect(v).toBe(2);
    expect(graph.version).toBe(2);
    expect(graph.rules).toBe(v2Rules);
    expect(graph.pendingChange).toBeUndefined();
    expect(graph.versions).toHaveLength(1);
    expect(graph.versions[0]!.approvedBy).toBe('owner');
  });

  it('approve() throws with no pending change; propose() rejects invalid rules', () => {
    const graph = makeGraph(v1Rules, parts);
    expect(() => approveRuleChange(graph, 'owner', 'owner')).toThrow(/no pending rule change/);
    expect(() =>
      proposeRuleChange(graph, 'owner', [remainder('a', 2, 'owner'), remainder('b', 3, 'owner')]),
    ).toThrow(/exactly one/);
  });
});

describe('event envelope validation', () => {
  it('accepts a minimal valid event', () => {
    const e = validateEvent({
      eventId: 'e1', graphId: 'g1', type: 'SALE_COMPLETED', occurredAt: '2026-10-03T12:00:00.000Z',
      amountMicros: 100, currency: 'USD', rail: 'stripe', processingCostMicros: 0, raw: {},
    });
    expect(e.eventId).toBe('e1');
  });

  it('rejects unknown types, bad rails, bad dates, bad money', () => {
    const base = {
      eventId: 'e1', graphId: 'g1', type: 'SALE_COMPLETED', occurredAt: '2026-10-03T12:00:00.000Z',
      amountMicros: 100, currency: 'USD', rail: 'stripe', processingCostMicros: 0, raw: {},
    };
    expect(() => validateEvent({ ...base, type: 'NOPE' })).toThrow(/unknown type/);
    expect(() => validateEvent({ ...base, rail: 'pigeon' })).toThrow(/unknown rail/);
    expect(() => validateEvent({ ...base, occurredAt: 'not-a-date' })).toThrow(/ISO 8601/);
    expect(() => validateEvent({ ...base, amountMicros: -1 })).toThrow(/micro-units/);
    expect(() => validateEvent({ ...base, amountMicros: 1.5 })).toThrow(/micro-units/);
    expect(() => validateEvent({ ...base, amountMicros: '100' })).toThrow(/micro-units/);
    expect(() => validateEvent({ ...base, eventId: '' })).toThrow(/non-empty string/);
    expect(() => validateEvent({ ...base, raw: null })).toThrow(/'raw' must be an object/);
  });

  it('requires TOUCH events to carry amountMicros 0', () => {
    expect(() =>
      validateEvent({
        eventId: 't1', graphId: 'g1', type: 'TOUCH', occurredAt: '2026-10-03T12:00:00.000Z',
        amountMicros: 5, currency: 'USD', rail: 'manual', processingCostMicros: 0, raw: {},
      }),
    ).toThrow(/TOUCH events are zero-amount/);
  });

  it('event store rejects duplicate eventIds', () => {
    const store = new InMemoryEventStore();
    store.append(makeEvent());
    expect(() => store.append(makeEvent())).toThrow(/duplicate eventId/);
  });
});

describe('derivative / downstream lineage (derivedFrom)', () => {
  it('applies a downstream-scoped rule only to events with matching lineage', () => {
    const { engine, deps } = makeDeps();
    const rules: Rule[] = [
      {
        id: 'downstream-royalty',
        type: 'percentage',
        priority: 1,
        params: { rateBps: 1000, subjectParticipantId: 'licensor' },
        conditions: { derivedFrom: ['asset:track-042'] },
      },
      remainder('r', 99, 'owner'),
    ];
    const graph = makeGraph(rules, [participant('licensor'), participant('owner')]);

    const downstream = makeEvent({ eventId: 'e-down', derivedFrom: 'asset:track-042' });
    const res = engine.evaluate(graph, downstream, deps);
    const lic = res.entitlements.find((e) => e.participantId === 'licensor');
    expect(lic).toBeDefined();
    expect(lic!.amountMicros).toBe(9_670_000); // 10% of $96.70 pool

    const unrelated = makeEvent({ eventId: 'e-other', derivedFrom: 'asset:other-1' });
    const res2 = engine.evaluate(graph, unrelated, deps);
    expect(res2.entitlements.find((e) => e.participantId === 'licensor')).toBeUndefined();
    expect(res2.skipped.find((s) => s.ruleId === 'downstream-royalty')).toBeDefined();
    expect(res2.skipped.find((s) => s.ruleId === 'downstream-royalty')!.reason).toMatch(/downstream scope/);
  });

  it('skips a downstream-scoped rule when the event carries no lineage', () => {
    const { engine, deps } = makeDeps();
    const rules: Rule[] = [
      {
        id: 'downstream-royalty',
        type: 'percentage',
        priority: 1,
        params: { rateBps: 1000, subjectParticipantId: 'licensor' },
        conditions: { derivedFrom: ['asset:track-042'] },
      },
      remainder('r', 99, 'owner'),
    ];
    const graph = makeGraph(rules, [participant('licensor'), participant('owner')]);
    const res = engine.evaluate(graph, makeEvent({ eventId: 'e-nolineage' }), deps);
    expect(res.entitlements.find((e) => e.participantId === 'licensor')).toBeUndefined();
    expect(res.skipped.find((s) => s.ruleId === 'downstream-royalty')!.reason).toMatch(/derives from 'nothing'/);
  });

  it('a downstream event on a different rail still triggers the entitlement (cross-rail continuity)', () => {
    const { engine, deps } = makeDeps();
    const rules: Rule[] = [
      {
        id: 'downstream-royalty',
        type: 'percentage',
        priority: 1,
        params: { rateBps: 1000, subjectParticipantId: 'licensor' },
        conditions: { derivedFrom: ['asset:track-042'] },
      },
      remainder('r', 99, 'owner'),
    ];
    const graph = makeGraph(rules, [participant('licensor'), participant('owner')]);
    // Same lineage, different rail: the entitlement must survive the rail change.
    const res = engine.evaluate(
      graph,
      makeEvent({ eventId: 'e-x402', rail: 'x402', derivedFrom: 'asset:track-042' }),
      deps,
    );
    expect(res.entitlements.find((e) => e.participantId === 'licensor')).toBeDefined();
  });

  it('validateEvent accepts and preserves derivedFrom', () => {
    const e = validateEvent({ ...makeEvent(), derivedFrom: 'asset:track-042' });
    expect(e.derivedFrom).toBe('asset:track-042');
    expect(() => validateEvent({ ...makeEvent(), derivedFrom: 42 })).toThrow(/must be a string/);
  });

  it('validateGraph rejects malformed derivedFrom conditions', () => {
    const bad: Rule = {
      id: 'x',
      type: 'percentage',
      priority: 1,
      params: { rateBps: 100, subjectParticipantId: 'owner' },
      conditions: { derivedFrom: [] as unknown as string[] },
    };
    const graph = makeGraph([bad, remainder('r', 99, 'owner')], [participant('owner')]);
    expect(validateGraph(graph)).toEqual(
      expect.arrayContaining([expect.stringMatching(/derivedFrom must be a non-empty string array/)]),
    );
  });
});
