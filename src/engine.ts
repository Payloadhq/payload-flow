/**
 * engine.ts — PayloadEvaluationEngine.
 *
 * Deterministic, stateful, idempotent evaluation of one economic event against
 * a revenue graph's ACTIVE rule version (graph.rules at graph.version).
 *
 * evaluate(graph, event, deps):
 *   1. validate the event envelope and the graph (graph must be 'active')
 *   2. idempotency: eventId already in the event store AND ledger entries
 *      exist for it -> return the prior result with idempotentReplay:true
 *      and zero side effects
 *   3. append the event to the event store
 *   4. pool = amountMicros - processingCostMicros (floored at 0)
 *   5. evaluate expanded rules in priority order (ties -> rule id); each rule
 *      checks conditions, computes its allocation, consumes from the pool
 *      sequentially; skips are recorded with reasons
 *   6. payload_fee rules delegate to deps.feeEngine.computeFee
 *   7. ledger appends: ENTITLEMENT / FEE per allocation, SKIPPED per skip
 *   8. state store updates: recoupment balances, capped cumulative totals,
 *      milestone flags, attribution determinations
 *   9. CONTRIBUTION ledger records, one per entitlement
 *  10. Distribution instructions (status 'proposed' — the engine NEVER executes
 *      payouts and NEVER holds funds; a regulated partner does)
 *  11. recordVolume on the fee engine (non-replay evaluations only)
 *  12. return the EvaluationResult
 *
 * Money math: every computed amount is rounded half-up to the microdollar
 * using exact BigInt integer arithmetic (no floats in the money path).
 * `remainder` absorbs whatever is left, so the pool is conserved exactly:
 * sum(entitlements) + sum(fees) == pool, always.
 *
 * simulate(graph, event, deps): identical computation with ZERO side effects.
 * Mechanism: simulate runs the exact same runEvaluation code path but with
 * scratch facades over the real deps —
 *   - EventStore: reads delegate to the real store (attribution lookback and
 *     the idempotency check see true state); append/appendTouch are no-ops.
 *   - StateStore: copy-on-write overlay — reads fall through to the real
 *     store, writes land only in the overlay, which is discarded.
 *   - Ledger: appends are discarded (a synthetic entry is returned); reads
 *     delegate to the real ledger so idempotency sees true state.
 *   - FeeEngine: computeFee delegates (pure); recordVolume is a no-op.
 * Because the facades implement the same interfaces, the computation cannot
 * diverge from evaluate by construction. recordVolume is additionally gated
 * on !isSimulate for clarity.
 *
 * Determinism: no Date.now() anywhere in evaluation logic. The only
 * wall-clock use is the ledger entry `at` timestamp (allowed by contract).
 * All time-window checks (effectiveFrom/To, attribution windows) use the
 * event's occurredAt.
 */
import { validateEvent } from './events.js';
import { coreRule, expandAllRules, validateGraph } from './rules.js';
import type {
  AttributionParams,
  CappedParams,
  ComputedFee,
  Distribution,
  EconomicEvent,
  EngineDeps,
  Entitlement,
  EvaluationEngine,
  EvaluationResult,
  EventStore,
  FeeEngine,
  FixedParams,
  Ledger,
  LedgerEntry,
  LicenseTier,
  MilestoneParams,
  Participant,
  PayloadFeeParams,
  PercentageParams,
  PerUseParams,
  PlatformFeeParams,
  RecoupmentParams,
  ReferralParams,
  RemainderParams,
  RevenueGraph,
  Rule,
  StatePredicate,
  StateStore,
  TimeLimitedParams,
} from './types.js';

// ---------------------------------------------------------------------------
// Exact money math (no floats)
// ---------------------------------------------------------------------------

/** round-half-up(a * b / c); a, b, c must be integers, c > 0. */
export function mulDivRoundHalfUp(a: number, b: number, c: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || c <= 0) {
    throw new Error(`mulDivRoundHalfUp: integer args required, c > 0 (got ${a}, ${b}, ${c})`);
  }
  if (a < 0 || b < 0) throw new Error('mulDivRoundHalfUp: negative amounts are not supported');
  const result = (2n * BigInt(a) * BigInt(b) + BigInt(c)) / (2n * BigInt(c));
  return Number(result);
}

/** ceil(a / b) for integers, b > 0. */
function ceilDiv(a: number, b: number): number {
  return Number((BigInt(a) + BigInt(b) - 1n) / BigInt(b));
}

/**
 * round-half-up(rateMicrosPerUnit * usageUnits) where usageUnits may be
 * fractional (unit-agnostic metering). Exact via decimal scaling.
 */
function mulRateByUnitsRoundHalfUp(rateMicrosPerUnit: number, usageUnits: number): number {
  if (Number.isInteger(usageUnits)) return mulDivRoundHalfUp(rateMicrosPerUnit, usageUnits, 1);
  const s = usageUnits.toString();
  const dot = s.indexOf('.');
  const decimals = dot === -1 ? 0 : s.length - dot - 1;
  const digits = s.replace('.', '').replace('-', '');
  if (!/^\d+$/.test(digits)) {
    throw new Error(`mulRateByUnitsRoundHalfUp: unsupported usageUnits ${String(usageUnits)}`);
  }
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(rateMicrosPerUnit) * BigInt(digits);
  return Number((2n * raw + scale) / (2n * scale));
}

/** Format micro-units as $d.cc for human-readable reasons. */
function formatMoney(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(micros));
  const dollars = Math.floor(abs / 1_000_000);
  const cents = Math.floor((abs % 1_000_000) / 10_000);
  return `${sign}$${dollars}.${String(cents).padStart(2, '0')}`;
}

function formatPct(rateBps: number): string {
  return `${(rateBps / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Scratch facades for simulate()
// ---------------------------------------------------------------------------

/** Event store facade: reads see the real store; writes are discarded. */
export class ReadThroughNoopEventStore implements EventStore {
  constructor(private readonly real: EventStore) {}
  append(_event: EconomicEvent | import('./types.js').TouchEvent): void {
    /* discarded: simulate must not ingest */
  }
  appendTouch(_touch: import('./types.js').TouchEvent): void {
    /* discarded */
  }
  getEvent(eventId: string): (EconomicEvent | import('./types.js').TouchEvent) | undefined {
    return this.real.getEvent(eventId);
  }
  queryTouches(filter: {
    graphId: string;
    referrerId?: string;
    campaignId?: string;
    from?: string;
    to?: string;
  }): import('./types.js').TouchEvent[] {
    return this.real.queryTouches(filter);
  }
  queryEvents(filter: {
    graphId: string;
    type?: import('./types.js').EventType;
    from?: string;
    to?: string;
  }): EconomicEvent[] {
    return this.real.queryEvents(filter);
  }
}

/** State store facade: copy-on-write overlay; the real store is never mutated. */
export class OverlayStateStore implements StateStore {
  private readonly overlay = new Map<string, number>();
  constructor(private readonly real: StateStore) {}
  private key(graphId: string, ruleId: string, participantId: string, key: string): string {
    return [graphId, ruleId, participantId, key].join(' ');
  }
  get(graphId: string, ruleId: string, participantId: string, key: string): number | undefined {
    const k = this.key(graphId, ruleId, participantId, key);
    return this.overlay.has(k) ? this.overlay.get(k) : this.real.get(graphId, ruleId, participantId, key);
  }
  set(graphId: string, ruleId: string, participantId: string, key: string, value: number): void {
    this.overlay.set(this.key(graphId, ruleId, participantId, key), value);
  }
  add(graphId: string, ruleId: string, participantId: string, key: string, delta: number): number {
    const next = (this.get(graphId, ruleId, participantId, key) ?? 0) + delta;
    this.set(graphId, ruleId, participantId, key, next);
    return next;
  }
}

/**
 * Ledger facade: appends are discarded; reads delegate to the real ledger so
 * the idempotency check in runEvaluation sees true state (a simulate() of an
 * already-processed event returns the prior result, exactly like evaluate()).
 */
export class NoopLedger implements Ledger {
  constructor(private readonly real: Ledger) {}
  append(entry: Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'at'>): LedgerEntry {
    return { seq: 0, at: '', prevHash: '', hash: '', ...entry };
  }
  entries(): LedgerEntry[] {
    return this.real.entries();
  }
  entriesForEvent(eventId: string): LedgerEntry[] {
    return this.real.entriesForEvent(eventId);
  }
  entriesForGraph(graphId: string): LedgerEntry[] {
    return this.real.entriesForGraph(graphId);
  }
  verifyChain(): boolean {
    return this.real.verifyChain();
  }
}

/** Fee engine facade: computeFee delegates (pure); recordVolume is discarded. */
export class NoVolumeFeeEngine implements FeeEngine {
  constructor(private readonly real: FeeEngine) {}
  computeFee(args: {
    amountMicros: number;
    processingCostMicros: number;
    rail: import('./types.js').Rail;
    accountId: string;
    license: import('./types.js').License;
    at: string;
  }): { feeMicros: number; rateBps: number; netMicros: number; tier: LicenseTier } {
    return this.real.computeFee(args);
  }
  recordVolume(_accountId: string, _at: string, _netMicros: number): void {
    /* discarded: simulate must not record volume */
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface EvalCtx {
  graph: RevenueGraph;
  event: EconomicEvent;
  deps: EngineDeps;
  participants: Map<string, Participant>;
  /** Pool remaining to be consumed; rules consume sequentially. */
  remaining: number;
  atMs: number;
}

type RuleOutcome =
  | { kind: 'allocated'; participantId: string; amountMicros: number; reason: string }
  | { kind: 'fee'; feeKind: 'platform_fee' | 'payload_fee'; amountMicros: number; rateBps: number; reason: string }
  | { kind: 'skipped'; reason: string };

const skipped = (reason: string): RuleOutcome => ({ kind: 'skipped', reason });

function parseStateKey(stateKey: string): { ruleId: string; participantId: string; key: string } {
  const parts = stateKey.split('.');
  if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) {
    throw new Error(`invalid stateKey '${stateKey}': expected 'ruleId.key' or 'ruleId.participantId.key'`);
  }
  return {
    ruleId: parts[0]!,
    participantId: parts.length > 2 ? parts.slice(1, -1).join('.') : '',
    key: parts[parts.length - 1]!,
  };
}

function testPredicate(value: number, op: StatePredicate['op'], target: number): boolean {
  switch (op) {
    case 'lt':
      return value < target;
    case 'lte':
      return value <= target;
    case 'gte':
      return value >= target;
    case 'gt':
      return value > target;
    case 'eq':
      return value === target;
    case 'neq':
      return value !== target;
  }
}

export class PayloadEvaluationEngine implements EvaluationEngine {
  /**
   * @param boundDeps engine-bound deps, used by triggerMilestone (which takes
   *   no deps argument per the contract). evaluate/simulate use the deps
   *   passed to each call.
   */
  constructor(private readonly boundDeps: EngineDeps) {}

  evaluate(graph: RevenueGraph, event: EconomicEvent, deps: EngineDeps): EvaluationResult {
    return this.runEvaluation(graph, event, deps, false);
  }

  simulate(graph: RevenueGraph, event: EconomicEvent, deps: EngineDeps): EvaluationResult {
    const scratch: EngineDeps = {
      eventStore: new ReadThroughNoopEventStore(deps.eventStore),
      stateStore: new OverlayStateStore(deps.stateStore),
      ledger: new NoopLedger(deps.ledger),
      feeEngine: new NoVolumeFeeEngine(deps.feeEngine),
      accounting: deps.accounting,
    };
    return this.runEvaluation(graph, event, scratch, true);
  }

  triggerMilestone(graph: RevenueGraph, ruleId: string, triggeredBy: string): void {
    const rule = graph.rules.find((r) => r.id === ruleId);
    if (!rule) {
      throw new Error(`triggerMilestone: graph '${graph.id}' has no rule '${ruleId}' (triggered by '${triggeredBy}')`);
    }
    if (rule.type !== 'milestone') {
      throw new Error(
        `triggerMilestone: rule '${ruleId}' is type '${rule.type}', not 'milestone' (triggered by '${triggeredBy}')`,
      );
    }
    this.boundDeps.stateStore.set(graph.id, ruleId, '', 'triggered', 1);
  }

  // -------------------------------------------------------------------------

  private runEvaluation(
    graph: RevenueGraph,
    event: EconomicEvent,
    deps: EngineDeps,
    isSimulate: boolean,
  ): EvaluationResult {
    // (1) validate event + graph (graph must be active)
    const validEvent = validateEvent(event);
    const graphErrors = validateGraph(graph);
    if (graphErrors.length > 0) {
      throw new Error(`invalid revenue graph '${graph.id}':\n- ${graphErrors.join('\n- ')}`);
    }
    if (graph.status !== 'active') {
      throw new Error(
        `graph '${graph.id}' has status '${graph.status}': only 'active' graphs evaluate events`,
      );
    }

    const eventId = validEvent.eventId;
    const graphId = validEvent.graphId;

    // (2) idempotency: event seen AND ledger entries exist -> replay, zero side effects
    const existing = deps.eventStore.getEvent(eventId);
    const priorEntries = deps.ledger.entriesForEvent(eventId);
    if (existing && priorEntries.length > 0) {
      return this.replayResult(graph, validEvent, priorEntries);
    }
    if (existing) {
      throw new Error(
        `event '${eventId}' was already ingested but has no completed evaluation in the ledger; manual review required before reprocessing`,
      );
    }

    // (3) append the event to the event store
    deps.eventStore.append(validEvent);

    // (4) pool = amount - processing cost, floored at 0
    const pool = Math.max(0, validEvent.amountMicros - validEvent.processingCostMicros);

    const participants = new Map<string, Participant>(graph.participants.map((p) => [p.id, p]));
    const ctx: EvalCtx = {
      graph,
      event: validEvent,
      deps,
      participants,
      remaining: pool,
      atMs: Date.parse(validEvent.occurredAt),
    };

    // (5) expanded rules in priority order (ties broken deterministically by rule id)
    const ordered = expandAllRules(graph.rules).sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1,
    );

    const result: EvaluationResult = {
      eventId,
      graphId,
      graphVersion: graph.version,
      entitlements: [],
      fees: [],
      skipped: [],
      distributions: [],
      idempotentReplay: false,
    };

    for (const rule of ordered) {
      const outcome = this.computeRule(rule, rule.id, ctx);
      if (outcome.kind === 'skipped') {
        // (7a) every skip is explained in the ledger
        result.skipped.push({ ruleId: rule.id, reason: outcome.reason });
        deps.ledger.append({
          eventId,
          graphId,
          graphVersion: graph.version,
          type: 'SKIPPED',
          ruleId: rule.id,
          reason: outcome.reason,
        });
        continue;
      }
      const amount = Math.min(outcome.amountMicros, ctx.remaining);
      ctx.remaining -= amount;
      if (outcome.kind === 'allocated') {
        const entitlement: Entitlement = {
          eventId,
          graphId,
          graphVersion: graph.version,
          ruleId: rule.id,
          participantId: outcome.participantId,
          amountMicros: amount,
          reason: outcome.reason,
        };
        result.entitlements.push(entitlement);
        deps.ledger.append({
          eventId,
          graphId,
          graphVersion: graph.version,
          type: 'ENTITLEMENT',
          ruleId: rule.id,
          participantId: outcome.participantId,
          amountMicros: amount,
          reason: outcome.reason,
        });
        // (9) auto-written contribution record, one per entitlement
        const role = participants.get(outcome.participantId)?.roles[0] ?? 'participant';
        deps.ledger.append({
          eventId,
          graphId,
          graphVersion: graph.version,
          type: 'CONTRIBUTION',
          participantId: outcome.participantId,
          reason: `contribution recorded for event '${eventId}' (role: ${role})`,
        });
      } else {
        const fee: ComputedFee = {
          kind: outcome.feeKind,
          amountMicros: amount,
          rateBps: outcome.rateBps,
          reason: outcome.reason,
        };
        result.fees.push(fee);
        deps.ledger.append({
          eventId,
          graphId,
          graphVersion: graph.version,
          type: 'FEE',
          ruleId: rule.id,
          amountMicros: amount,
          reason: outcome.reason,
        });
      }
    }

    // (10) distribution instructions: proposed only — never executed, never held
    result.distributions = this.buildDistributions(result.entitlements, ctx);

    // (11) volume is recorded only for real, non-replay evaluations
    if (!isSimulate) {
      deps.feeEngine.recordVolume(deps.accounting.accountId, validEvent.occurredAt, pool);
    }

    // (12)
    return result;
  }

  /** Rebuild the prior result from the ledger: no recomputation, no side effects. */
  private replayResult(
    graph: RevenueGraph,
    event: EconomicEvent,
    entries: LedgerEntry[],
  ): EvaluationResult {
    const entitlements: Entitlement[] = entries
      .filter((e) => e.type === 'ENTITLEMENT')
      .map((e) => ({
        eventId: e.eventId,
        graphId: e.graphId,
        graphVersion: e.graphVersion,
        ruleId: e.ruleId ?? '',
        participantId: e.participantId ?? '',
        amountMicros: e.amountMicros ?? 0,
        reason: e.reason,
      }));
    const fees: ComputedFee[] = entries
      .filter((e) => e.type === 'FEE')
      .map((e) => {
        const rule = graph.rules.find((r) => r.id === e.ruleId);
        const kind = rule && coreRule(rule).type === 'payload_fee' ? 'payload_fee' : 'platform_fee';
        const m = / (\d+)bps of net /.exec(e.reason);
        return {
          kind,
          amountMicros: e.amountMicros ?? 0,
          rateBps: m ? parseInt(m[1]!, 10) : 0,
          reason: e.reason,
        };
      });
    const skipped = entries
      .filter((e) => e.type === 'SKIPPED')
      .map((e) => ({ ruleId: e.ruleId ?? '', reason: e.reason }));
    const participants = new Map<string, Participant>(graph.participants.map((p) => [p.id, p]));
    const ctx: EvalCtx = {
      graph,
      event,
      deps: this.boundDeps,
      participants,
      remaining: 0,
      atMs: Date.parse(event.occurredAt),
    };
    return {
      eventId: event.eventId,
      graphId: event.graphId,
      graphVersion: entries[0]?.graphVersion ?? graph.version,
      entitlements,
      fees,
      skipped,
      distributions: this.buildDistributions(entitlements, ctx),
      idempotentReplay: true,
    };
  }

  private buildDistributions(entitlements: Entitlement[], ctx: EvalCtx): Distribution[] {
    const out: Distribution[] = [];
    for (const ent of entitlements) {
      const participant = ctx.participants.get(ent.participantId);
      if (!participant) continue;
      // Route by destination rail: prefer a destination matching the event rail,
      // else the participant's first destination. No destination -> the
      // entitlement stands but no instruction can be built (recorded nowhere
      // else; the entitlement itself is the audit trail).
      const destination =
        participant.payoutDestinations.find((d) => d.rail === ctx.event.rail) ??
        participant.payoutDestinations[0];
      if (!destination) continue;
      out.push({
        instructionId: `dist:${ent.eventId}:${ent.ruleId}:${ent.participantId}`,
        graphId: ent.graphId,
        eventId: ent.eventId,
        participantId: ent.participantId,
        destination,
        amountMicros: ent.amountMicros,
        currency: ctx.event.currency,
        rail: ctx.event.rail,
        status: 'proposed',
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-rule computation
  // -------------------------------------------------------------------------

  /** Check rule-level effective window + conditions. Returns the skip reason, if any. */
  private checkConditions(rule: Rule, ctx: EvalCtx): string | undefined {
    if (rule.effectiveFrom !== undefined && ctx.atMs < Date.parse(rule.effectiveFrom)) {
      return `rule not yet effective (effectiveFrom ${rule.effectiveFrom})`;
    }
    if (rule.effectiveTo !== undefined && ctx.atMs > Date.parse(rule.effectiveTo)) {
      return `rule expired (effectiveTo ${rule.effectiveTo})`;
    }
    const c = rule.conditions;
    // Referral rules default requireAttribution=true, even with no conditions block.
    const requireAttribution = c?.requireAttribution ?? coreRule(rule).type === 'referral';
    const event = ctx.event;
    if (requireAttribution && !event.attribution?.referrerId) {
      return 'rule requires attribution but the event carries no referrer claim';
    }
    if (!c) return undefined;
    if (c.eventTypes !== undefined && !c.eventTypes.includes(event.type)) {
      return `event type '${event.type}' not in rule scope [${c.eventTypes.join(', ')}]`;
    }
    if (c.minAmountMicros !== undefined && event.amountMicros < c.minAmountMicros) {
      return `event amount ${formatMoney(event.amountMicros)} below rule minimum ${formatMoney(c.minAmountMicros)}`;
    }
    if (c.maxAmountMicros !== undefined && event.amountMicros > c.maxAmountMicros) {
      return `event amount ${formatMoney(event.amountMicros)} above rule maximum ${formatMoney(c.maxAmountMicros)}`;
    }
    if (c.territories !== undefined) {
      if (event.territory === undefined || !c.territories.includes(event.territory)) {
        return `territory '${event.territory ?? 'none'}' not in rule scope [${c.territories.join(', ')}]`;
      }
    }
    if (c.rails !== undefined && !c.rails.includes(event.rail)) {
      return `rail '${event.rail}' not in rule scope [${c.rails.join(', ')}]`;
    }
    if (c.derivedFrom !== undefined) {
      if (event.derivedFrom === undefined || !c.derivedFrom.includes(event.derivedFrom)) {
        return `event derives from '${event.derivedFrom ?? 'nothing'}', not in rule downstream scope [${c.derivedFrom.join(', ')}]`;
      }
    }
    if (c.activeWhen !== undefined) {
      let ref;
      try {
        ref = parseStateKey(c.activeWhen.stateKey);
      } catch (err) {
        return `invalid activeWhen.stateKey: ${(err as Error).message}`;
      }
      const value =
        ctx.deps.stateStore.get(ctx.graph.id, ref.ruleId, ref.participantId, ref.key) ?? 0;
      if (!testPredicate(value, c.activeWhen.op, c.activeWhen.value)) {
        return `state predicate '${c.activeWhen.stateKey}' not satisfied (${value} ${c.activeWhen.op} ${c.activeWhen.value})`;
      }
    }
    if (c.licenseRef !== undefined) {
      return `license-gated condition '${c.licenseRef}' is modeled but not executed in v1`;
    }
    return undefined;
  }

  /**
   * Compute one rule's outcome WITHOUT consuming the pool (the caller consumes).
   * ledgerRuleId is the top-level graph rule id used for ledger + state keys;
   * wrapper inners recurse through here with the wrapper's id.
   */
  private computeRule(rule: Rule, ledgerRuleId: string, ctx: EvalCtx): RuleOutcome {
    const condReason = this.checkConditions(rule, ctx);
    if (condReason) return skipped(condReason);
    return this.computeCore(rule, ledgerRuleId, ctx);
  }

  private computeCore(rule: Rule, ledgerRuleId: string, ctx: EvalCtx): RuleOutcome {
    const { event, deps, graph } = ctx;
    const remaining = ctx.remaining;

    switch (rule.type) {
      case 'percentage': {
        const p = rule.params as PercentageParams & { upToMicros?: number };
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        let amount = mulDivRoundHalfUp(remaining, p.rateBps, 10000);
        if (p.upToMicros !== undefined) amount = Math.min(amount, p.upToMicros);
        amount = Math.min(amount, remaining);
        const cappedNote = p.upToMicros !== undefined ? ` (capped at ${formatMoney(p.upToMicros)})` : '';
        return {
          kind: 'allocated',
          participantId: p.subjectParticipantId,
          amountMicros: amount,
          reason: `${formatPct(p.rateBps)} of remaining pool ${formatMoney(remaining)}${cappedNote} -> ${formatMoney(amount)}`,
        };
      }

      case 'fixed': {
        const p = rule.params as FixedParams;
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        const amount = Math.min(p.amountMicros, remaining);
        return {
          kind: 'allocated',
          participantId: p.subjectParticipantId,
          amountMicros: amount,
          reason: `fixed ${formatMoney(p.amountMicros)} (limited by remaining pool ${formatMoney(remaining)}) -> ${formatMoney(amount)}`,
        };
      }

      case 'per_use': {
        const p = rule.params as PerUseParams;
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        if (event.usageUnits === undefined) {
          return skipped('per_use rule requires usageUnits on the event, which is missing');
        }
        const amount = Math.min(mulRateByUnitsRoundHalfUp(p.rateMicrosPerUnit, event.usageUnits), remaining);
        return {
          kind: 'allocated',
          participantId: p.subjectParticipantId,
          amountMicros: amount,
          reason: `per_use ${formatMoney(p.rateMicrosPerUnit)}/unit x ${event.usageUnits} units -> ${formatMoney(amount)}`,
        };
      }

      case 'referral': {
        const p = rule.params as ReferralParams;
        const referrerId = event.attribution?.referrerId;
        if (!referrerId) {
          return skipped('referral rule found no referrer claim on the event');
        }
        if (!ctx.participants.has(referrerId)) {
          return skipped(`attributed referrer '${referrerId}' is not a participant of this graph`);
        }
        const amount = Math.min(mulDivRoundHalfUp(remaining, p.rateBps, 10000), remaining);
        return {
          kind: 'allocated',
          participantId: referrerId,
          amountMicros: amount,
          reason: `referral ${formatPct(p.rateBps)} of remaining pool ${formatMoney(remaining)} to referrer '${referrerId}' -> ${formatMoney(amount)}`,
        };
      }

      case 'recoupment': {
        const p = rule.params as RecoupmentParams;
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        // INTRA-EVENT semantics: an event can complete the advance partway;
        // the rest of the same event's pool accrues at the post rate.
        const recouped = deps.stateStore.get(graph.id, ledgerRuleId, p.subjectParticipantId, 'recouped') ?? 0;
        const need = Math.max(0, p.advanceMicros - recouped);
        let take = 0;
        if (need > 0 && p.recoupRateBps > 0) {
          take = Math.min(remaining, ceilDiv(need * 10000, p.recoupRateBps));
        }
        let amt1 = take > 0 ? mulDivRoundHalfUp(take, p.recoupRateBps, 10000) : 0;
        amt1 = Math.min(amt1, need); // cumulative recoupment never exceeds the advance
        const rest = remaining - take;
        const amt2 = rest > 0 ? mulDivRoundHalfUp(rest, p.postRateBps, 10000) : 0;
        if (amt1 > 0) {
          deps.stateStore.add(graph.id, ledgerRuleId, p.subjectParticipantId, 'recouped', amt1);
        }
        const total = Math.min(amt1 + amt2, remaining);
        return {
          kind: 'allocated',
          participantId: p.subjectParticipantId,
          amountMicros: total,
          reason:
            `recoupment: ${formatMoney(amt1)} of ${formatMoney(p.advanceMicros)} advance at ${formatPct(p.recoupRateBps)} ` +
            `(cumulative ${formatMoney(recouped + amt1)}), ${formatMoney(amt2)} of pool remainder at post-rate ${formatPct(p.postRateBps)}`,
        };
      }

      case 'capped': {
        const p = rule.params as CappedParams;
        const innerOutcome = this.computeRule(p.inner, ledgerRuleId, ctx);
        if (innerOutcome.kind !== 'allocated') return innerOutcome;
        const cumulative = deps.stateStore.get(graph.id, ledgerRuleId, p.subjectParticipantId, 'capped.cumulative') ?? 0;
        const room = p.capMicros - cumulative;
        if (room <= 0) {
          return skipped(
            `cap reached: cumulative ${formatMoney(cumulative)} already meets cap ${formatMoney(p.capMicros)}`,
          );
        }
        const pay = Math.min(innerOutcome.amountMicros, room);
        deps.stateStore.add(graph.id, ledgerRuleId, p.subjectParticipantId, 'capped.cumulative', pay);
        return {
          kind: 'allocated',
          participantId: innerOutcome.participantId,
          amountMicros: pay,
          reason: `capped at ${formatMoney(p.capMicros)}: inner paid ${formatMoney(innerOutcome.amountMicros)} -> ${formatMoney(pay)} (cumulative ${formatMoney(cumulative + pay)})`,
        };
      }

      case 'time_limited': {
        const p = rule.params as TimeLimitedParams;
        if (ctx.atMs < Date.parse(p.effectiveFrom) || ctx.atMs > Date.parse(p.effectiveTo)) {
          return skipped(`outside effective window [${p.effectiveFrom}, ${p.effectiveTo}]`);
        }
        return this.computeRule(p.inner, ledgerRuleId, ctx);
      }

      case 'milestone': {
        const p = rule.params as MilestoneParams;
        const flag = deps.stateStore.get(graph.id, ledgerRuleId, '', 'triggered');
        if (flag !== 1) {
          return skipped(`milestone '${ledgerRuleId}' has not been triggered`);
        }
        return this.computeRule(p.inner, ledgerRuleId, ctx);
      }

      case 'attribution': {
        const p = rule.params as AttributionParams;
        const toMs = ctx.atMs;
        const fromMs = toMs - p.windowDays * 86400000;
        const touches = deps.eventStore.queryTouches({
          graphId: graph.id,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
        });
        if (touches.length === 0) {
          return skipped(`no touch events found in the ${p.windowDays}-day attribution window`);
        }
        const picked = p.model === 'first_touch' ? touches[0]! : touches[touches.length - 1]!;
        if (!ctx.participants.has(picked.referrerId)) {
          return skipped(`attributed referrer '${picked.referrerId}' is not a participant of this graph`);
        }
        const amount = Math.min(mulDivRoundHalfUp(remaining, p.rateBps, 10000), remaining);
        deps.stateStore.set(graph.id, ledgerRuleId, picked.referrerId, 'attribution.selected', 1);
        return {
          kind: 'allocated',
          participantId: picked.referrerId,
          amountMicros: amount,
          reason: `attribution (${p.model}): touch '${picked.eventId}' -> referrer '${picked.referrerId}' at ${formatPct(p.rateBps)} of pool -> ${formatMoney(amount)}`,
        };
      }

      case 'remainder': {
        const p = rule.params as RemainderParams;
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        return {
          kind: 'allocated',
          participantId: p.subjectParticipantId,
          amountMicros: remaining,
          reason: `remainder of pool -> ${formatMoney(remaining)}`,
        };
      }

      case 'payload_fee': {
        const p = rule.params as PayloadFeeParams;
        void p;
        const computed = deps.feeEngine.computeFee({
          amountMicros: event.amountMicros,
          processingCostMicros: event.processingCostMicros,
          rail: event.rail,
          accountId: deps.accounting.accountId,
          license: deps.accounting.license,
          at: event.occurredAt,
        });
        const amount = Math.min(computed.feeMicros, remaining);
        return {
          kind: 'fee',
          feeKind: 'payload_fee',
          amountMicros: amount,
          rateBps: computed.rateBps,
          reason: `payload_fee ${computed.rateBps}bps of net ${formatMoney(computed.netMicros)} (tier ${computed.tier}, rail ${event.rail}) -> ${formatMoney(amount)}`,
        };
      }

      case 'platform_fee': {
        const p = rule.params as PlatformFeeParams;
        if (!ctx.participants.has(p.subjectParticipantId)) {
          return skipped(`subject participant '${p.subjectParticipantId}' is not on this graph`);
        }
        const amount = Math.min(mulDivRoundHalfUp(remaining, p.rateBps, 10000), remaining);
        return {
          kind: 'fee',
          feeKind: 'platform_fee',
          amountMicros: amount,
          rateBps: p.rateBps,
          reason: `platform_fee ${formatPct(p.rateBps)} of remaining pool ${formatMoney(remaining)} -> ${formatMoney(amount)}`,
        };
      }

      case 'waterfall':
        throw new Error(
          `rule '${ledgerRuleId}': waterfall composites must be expanded before evaluation (engine bug)`,
        );
    }
  }
}
