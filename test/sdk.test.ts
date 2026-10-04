import { describe, expect, it, vi } from 'vitest';
import type {
  Adapter,
  EconomicEvent,
  EngineDeps,
  EvaluationEngine,
  EvaluationResult,
  Ledger,
  LedgerEntry,
  Participant,
  PercentageParams,
  Rule,
} from '../src/types.js';
import {
  activateGraph,
  approveRuleChange,
  defineGraph,
  formatSimulation,
  processEvent,
  proposeRuleChange,
  readLedger,
  simulateEvent,
} from '../src/sdk.js';

// ------------------------------------------------------------ test fixtures --
const owner: Participant = {
  id: 'owner-1',
  kind: 'person',
  roles: ['owner'],
  payoutDestinations: [],
};
const creator: Participant = {
  id: 'creator-1',
  kind: 'person',
  roles: ['contributor'],
  payoutDestinations: [],
};

const baseRules: Rule[] = [
  {
    id: 'platform-1',
    type: 'percentage',
    priority: 10,
    params: { rateBps: 600, subjectParticipantId: 'creator-1' } as PercentageParams,
  },
  { id: 'remainder-1', type: 'remainder', priority: 100, params: { subjectParticipantId: 'creator-1' } },
];

const event: EconomicEvent = {
  eventId: 'evt-1',
  graphId: 'g-1',
  type: 'SALE_COMPLETED',
  occurredAt: '2026-10-03T12:00:00Z',
  amountMicros: 100_000_000,
  currency: 'USD',
  rail: 'stripe',
  processingCostMicros: 3_200_000,
  raw: {},
};

const cannedResult: EvaluationResult = {
  eventId: 'evt-1',
  graphId: 'g-1',
  graphVersion: 1,
  entitlements: [
    {
      eventId: 'evt-1',
      graphId: 'g-1',
      graphVersion: 1,
      ruleId: 'platform-1',
      participantId: 'platform',
      amountMicros: 5_760_000,
      reason: '6% of net $96.70',
    },
  ],
  fees: [{ kind: 'payload_fee', amountMicros: 1_000_000, rateBps: 100, reason: '1% payload fee' }],
  skipped: [{ ruleId: 'referral-1', reason: 'no attribution claim on event' }],
  distributions: [],
  idempotentReplay: false,
};

function stubEngine() {
  const evaluate = vi.fn((_g: unknown, _e: unknown, _d: unknown) => cannedResult);
  const simulate = vi.fn((_g: unknown, _e: unknown, _d: unknown) => cannedResult);
  const engine: EvaluationEngine = {
    evaluate: evaluate as EvaluationEngine['evaluate'],
    simulate: simulate as EvaluationEngine['simulate'],
    triggerMilestone: () => {},
  };
  return { engine, evaluate, simulate };
}

class RecordingLedger implements Ledger {
  appended: LedgerEntry[] = [];
  append(entry: Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'at'>): LedgerEntry {
    const full: LedgerEntry = {
      ...entry,
      seq: this.appended.length,
      prevHash: this.appended.length === 0 ? 'genesis' : 'hash',
      hash: 'hash',
      at: new Date().toISOString(),
    };
    this.appended.push(full);
    return full;
  }
  entries(): LedgerEntry[] {
    return [...this.appended];
  }
  entriesForEvent(eventId: string): LedgerEntry[] {
    return this.appended.filter((e) => e.eventId === eventId);
  }
  entriesForGraph(graphId: string): LedgerEntry[] {
    return this.appended.filter((e) => e.graphId === graphId);
  }
  verifyChain(): boolean {
    return true;
  }
}

function depsWith(ledger: Ledger): EngineDeps {
  return { ledger } as unknown as EngineDeps;
}

// ------------------------------------------------------------- defineGraph --
describe('defineGraph', () => {
  it('builds a valid v1 structure', () => {
    const graph = defineGraph({
      id: 'g-1',
      projectId: 'p-1',
      ownerId: 'owner-1',
      participants: [owner, creator],
      rules: baseRules,
    });
    expect(graph.version).toBe(1);
    expect(graph.status).toBe('draft');
    expect(graph.versions).toHaveLength(1);
    expect(graph.versions[0]!.version).toBe(1);
    expect(graph.versions[0]!.changedBy).toBe('owner-1');
    expect(graph.rules).toHaveLength(2);
    expect(graph.pendingChange).toBeUndefined();
  });

  it('deep-copies inputs (no aliasing)', () => {
    const spec = {
      id: 'g-1',
      projectId: 'p-1',
      ownerId: 'owner-1',
      participants: [owner, creator],
      rules: structuredClone(baseRules), // fresh copy: this test mutates it
    };
    const graph = defineGraph(spec);
    spec.rules[0]!.id = 'MUTATED';
    expect(graph.rules[0]!.id).toBe('platform-1');
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'owner-1',
        participants: [owner, creator],
        rules: [baseRules[0]!, { ...baseRules[0]! }],
      }),
    ).toThrow(/duplicate rule id "platform-1"/);
  });

  it('rejects duplicate participant ids', () => {
    expect(() =>
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'owner-1',
        participants: [owner, { ...owner }],
        rules: baseRules,
      }),
    ).toThrow(/duplicate participant id "owner-1"/);
  });

  it('rejects more than one remainder rule', () => {
    expect(() =>
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'owner-1',
        participants: [owner, creator],
        rules: [
          ...baseRules,
          { id: 'remainder-2', type: 'remainder', priority: 200, params: { subjectParticipantId: 'creator-1' } },
        ],
      }),
    ).toThrow(/at most one remainder rule/);
  });

  it('rejects a remainder that is not the lowest priority', () => {
    expect(() =>
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'owner-1',
        participants: [owner, creator],
        rules: [
          { ...baseRules[0]!, priority: 5 },
          { ...baseRules[1]!, priority: 1 }, // remainder evaluated first: invalid
        ],
      }),
    ).toThrow(/must have the lowest priority/);
  });

  it('requires the owner to be a participant with the owner role', () => {
    expect(() =>
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'ghost',
        participants: [owner, creator],
        rules: baseRules,
      }),
    ).toThrow(/not a participant/);
  });
});

// ------------------------------------------------------------ activateGraph --
describe('activateGraph', () => {
  it('transitions draft → active without mutating the input', () => {
    const draft = defineGraph({
      id: 'g-1',
      projectId: 'p-1',
      ownerId: 'owner-1',
      participants: [owner, creator],
      rules: baseRules,
    });
    const active = activateGraph(draft);
    expect(active.status).toBe('active');
    expect(draft.status).toBe('draft');
    expect(active.version).toBe(draft.version);
  });

  it('refuses to activate a non-draft graph', () => {
    const draft = defineGraph({
      id: 'g-1',
      projectId: 'p-1',
      ownerId: 'owner-1',
      participants: [owner, creator],
      rules: baseRules,
    });
    const active = activateGraph(draft);
    expect(() => activateGraph(active)).toThrow(/cannot activate.*from status "active"/);
  });
});

// ------------------------------------------------------------- processEvent --
describe('processEvent', () => {
  const graph = () =>
    activateGraph(
      defineGraph({
        id: 'g-1',
        projectId: 'p-1',
        ownerId: 'owner-1',
        participants: [owner, creator],
        rules: baseRules,
      }),
    );

  it('routes adapter output into engine.evaluate', () => {
    const { engine, evaluate } = stubEngine();
    const adapter: Adapter = { kind: 'test', toEvents: (raw: unknown) => [{ ...event, raw: { raw } }] };
    const results = processEvent(engine, graph(), depsWith(new RecordingLedger()), {
      adapter,
      raw: { hello: 'world' },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    const [, evaluatedEvent, depsArg] = evaluate.mock.calls[0]!;
    expect((evaluatedEvent as EconomicEvent).eventId).toBe('evt-1');
    expect((evaluatedEvent as EconomicEvent).raw).toEqual({ raw: { hello: 'world' } });
    expect(depsArg).toBeDefined();
    expect(results).toHaveLength(1);
    expect(results[0]!.eventId).toBe('evt-1');
  });

  it('accepts a canonical EconomicEvent directly', () => {
    const { engine, evaluate } = stubEngine();
    const results = processEvent(engine, graph(), depsWith(new RecordingLedger()), event);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it('rejects events bound to a different graph', () => {
    const { engine } = stubEngine();
    expect(() =>
      processEvent(engine, graph(), depsWith(new RecordingLedger()), {
        ...event,
        graphId: 'other-graph',
      }),
    ).toThrow(/does not match graph "g-1"/);
  });
});

// ------------------------------------------------------------ simulateEvent --
describe('simulateEvent', () => {
  it('formats explanations and causes zero ledger interaction', () => {
    const { engine, simulate, evaluate } = stubEngine();
    const ledger = new RecordingLedger();
    const summary = simulateEvent(
      engine,
      activateGraph(
        defineGraph({
          id: 'g-1',
          projectId: 'p-1',
          ownerId: 'owner-1',
          participants: [owner, creator],
          rules: baseRules,
        }),
      ),
      depsWith(ledger),
      event,
    );
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled(); // dry-run: never evaluate
    expect(ledger.appended).toHaveLength(0); // dry-run: no side effects
    expect(summary.entitlements).toHaveLength(1);
    expect(summary.fees).toHaveLength(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.explanations).toEqual([
      '6% of net $96.70',
      '1% payload fee',
      'referral-1: no attribution claim on event',
    ]);
    expect(summary.lines).toContain(
      'platform ← $5.76 (6% of net $96.70) [rule platform-1]',
    );
    expect(summary.lines).toContain('payload_fee fee $1.00 — 1% payload fee');
    expect(summary.lines).toContain('skipped referral-1: no attribution claim on event');
  });

  it('formatSimulation flags replays', () => {
    const lines = formatSimulation({ ...cannedResult, idempotentReplay: true }, 'USD');
    expect(lines[0]).toMatch(/REPLAY/);
  });
});

// -------------------------------------------------------------- readLedger --
describe('readLedger', () => {
  it('filters by graphId, eventId, participantId, and type', () => {
    const ledger = new RecordingLedger();
    ledger.append({
      eventId: 'e1',
      graphId: 'g-1',
      graphVersion: 1,
      type: 'ENTITLEMENT',
      ruleId: 'r1',
      participantId: 'p1',
      amountMicros: 100,
      reason: 'r',
    });
    ledger.append({
      eventId: 'e1',
      graphId: 'g-1',
      graphVersion: 1,
      type: 'FEE',
      participantId: 'p2',
      amountMicros: 10,
      reason: 'f',
    });
    ledger.append({
      eventId: 'e2',
      graphId: 'g-2',
      graphVersion: 1,
      type: 'ENTITLEMENT',
      participantId: 'p1',
      amountMicros: 50,
      reason: 'r2',
    });
    expect(readLedger(ledger, { graphId: 'g-1' })).toHaveLength(2);
    expect(readLedger(ledger, { eventId: 'e2' })).toHaveLength(1);
    expect(readLedger(ledger, { participantId: 'p1' })).toHaveLength(2);
    expect(readLedger(ledger, { type: 'FEE' })).toHaveLength(1);
    expect(readLedger(ledger, { graphId: 'g-1', type: 'ENTITLEMENT' })).toHaveLength(1);
    expect(readLedger(ledger, {})).toHaveLength(3);
  });
});

// ------------------------------------------- proposeRuleChange/approveRuleChange --
describe('rule change approval gate', () => {
  const draft = () =>
    defineGraph({
      id: 'g-1',
      projectId: 'p-1',
      ownerId: 'owner-1',
      participants: [owner, creator],
      rules: baseRules,
    });

  const newRules: Rule[] = [
    {
      id: 'platform-1',
      type: 'percentage',
      priority: 10,
      params: { rateBps: 900, subjectParticipantId: 'creator-1' } as PercentageParams,
    },
    { id: 'remainder-1', type: 'remainder', priority: 100, params: { subjectParticipantId: 'creator-1' } },
  ];

  it('proposeRuleChange sets the pending change on a copy', () => {
    const g = draft();
    const proposed = proposeRuleChange(g, { proposedBy: 'owner-1', rules: newRules, note: 'raise fee' });
    expect(proposed.pendingChange).toMatchObject({ proposedBy: 'owner-1', note: 'raise fee' });
    expect(g.pendingChange).toBeUndefined(); // input untouched
    expect(() => proposeRuleChange(proposed, { proposedBy: 'owner-1', rules: newRules })).toThrow(
      /already pending/,
    );
  });

  it('non-owner approval throws', () => {
    const proposed = proposeRuleChange(draft(), { proposedBy: 'owner-1', rules: newRules });
    expect(() => approveRuleChange(proposed, { approvedBy: 'creator-1' })).toThrow(
      /only the graph owner \(owner-1\) can approve/,
    );
  });

  it('owner approval bumps the version, records history, and clears the pending change', () => {
    const proposed = proposeRuleChange(draft(), {
      proposedBy: 'owner-1',
      rules: newRules,
      note: 'raise fee',
    });
    const approved = approveRuleChange(proposed, { approvedBy: 'owner-1' });
    expect(approved.version).toBe(2);
    expect(approved.rules[0]!.params).toEqual({
      rateBps: 900,
      subjectParticipantId: 'creator-1',
    });
    expect(approved.pendingChange).toBeUndefined();
    expect(approved.versions).toHaveLength(2);
    expect(approved.versions[1]).toMatchObject({
      version: 2,
      changedBy: 'owner-1',
      approvedBy: 'owner-1',
      note: 'raise fee',
    });
    // input graph untouched: still version 1 with pending change
    expect(proposed.version).toBe(1);
    expect(proposed.pendingChange).toBeDefined();
  });

  it('approving with no pending change throws', () => {
    expect(() => approveRuleChange(draft(), { approvedBy: 'owner-1' })).toThrow(/no pending rule change/);
  });
});
