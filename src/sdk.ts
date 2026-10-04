/**
 * Payload Flow developer SDK (v1).
 *
 * Convenience surface over the canonical types: graph definition,
 * activation, event ingestion (adapter → engine), ledger reads, dry-run
 * simulation, and the rule-change approval gate.
 *
 * Independence note: the SDK treats graphs as immutable values (every function
 * returns a copy, never mutates inputs). The canonical rule-change approval
 * gate lives in graph.ts; the SDK delegates to it on clones, adding only
 * friendlier pre-check errors. Full graph validation lives in rules.ts
 * (`validateGraph`); the SDK runs a LOCAL structural check only (unique ids,
 * remainder ≤ 1 with lowest priority) at definition time.
 */

import {
  approveRuleChange as canonicalApproveRuleChange,
  proposeRuleChange as canonicalProposeRuleChange,
} from './graph.js';
import type {
  Adapter,
  ComputedFee,
  EconomicEvent,
  EngineDeps,
  Entitlement,
  EvaluationEngine,
  EvaluationResult,
  GraphVersionRecord,
  Ledger,
  LedgerEntry,
  LedgerEntryType,
  Participant,
  RevenueGraph,
  RevenueSource,
  Rule,
  TouchEvent,
} from './types.js';

export interface GraphSpec {
  id: string;
  projectId: string;
  ownerId: string;
  participants: Participant[];
  revenueSources?: RevenueSource[];
  rules: Rule[];
}

export interface RuleChangeProposal {
  proposedBy: string;
  rules: Rule[];
  note?: string;
}

export interface RuleChangeApproval {
  approvedBy: string;
}

/** Adapter input form for processEvent. */
export interface RawAdapterInput {
  adapter: Adapter;
  raw: unknown;
}

function fail(message: string): never {
  throw new Error(`sdk: ${message}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isAdapterInput(input: EconomicEvent | RawAdapterInput): input is RawAdapterInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'adapter' in input &&
    typeof (input as RawAdapterInput).adapter?.toEvents === 'function'
  );
}

function isEconomicEvent(e: EconomicEvent | TouchEvent): e is EconomicEvent {
  return typeof (e as EconomicEvent).amountMicros === 'number';
}

/**
 * LOCAL structural check (documented limitation: full validation lives in
 * the sibling track's `validateGraph`). Enforces:
 * - participant ids unique
 * - rule ids unique
 * - at most one remainder rule, and if present it has the lowest priority
 *   (highest priority number — evaluated last)
 */
function checkRulesStructure(rules: Rule[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id) fail('rule is missing id');
    if (ids.has(rule.id)) fail(`duplicate rule id "${rule.id}"`);
    ids.add(rule.id);
  }
  const remainders = rules.filter((r) => r.type === 'remainder');
  if (remainders.length > 1) {
    fail(`at most one remainder rule per graph, found ${remainders.length}`);
  }
  const remainder = remainders[0];
  if (remainder) {
    for (const rule of rules) {
      if (rule !== remainder && rule.priority > remainder.priority) {
        fail(
          `remainder rule "${remainder.id}" must have the lowest priority ` +
            `(highest number); rule "${rule.id}" has priority ${rule.priority} > ${remainder.priority}`,
        );
      }
    }
  }
}

/**
 * Build a v1 graph from a spec: version 1, status 'draft', versions[0]
 * seeded. Returns a deep copy of all inputs.
 */
export function defineGraph(spec: GraphSpec): RevenueGraph {
  if (!spec.id) fail('graph spec is missing id');
  if (!spec.projectId) fail('graph spec is missing projectId');
  if (!spec.ownerId) fail('graph spec is missing ownerId');

  const participantIds = new Set<string>();
  for (const p of spec.participants ?? []) {
    if (!p.id) fail('participant is missing id');
    if (participantIds.has(p.id)) fail(`duplicate participant id "${p.id}"`);
    participantIds.add(p.id);
  }
  const owner = (spec.participants ?? []).find((p) => p.id === spec.ownerId);
  if (!owner) fail(`ownerId "${spec.ownerId}" is not a participant of the graph`);
  if (!owner.roles.includes('owner')) {
    fail(`ownerId "${spec.ownerId}" must carry the 'owner' role for the approval gate`);
  }

  checkRulesStructure(spec.rules ?? []);

  const rules = clone(spec.rules ?? []);
  const versionRecord: GraphVersionRecord = {
    version: 1,
    rules,
    changedBy: spec.ownerId,
    at: nowIso(),
    note: 'initial graph definition',
  };
  const graph: RevenueGraph = {
    id: spec.id,
    projectId: spec.projectId,
    version: 1,
    status: 'draft',
    participants: clone(spec.participants ?? []),
    revenueSources: clone(spec.revenueSources ?? []),
    rules,
    versions: [versionRecord],
  };
  return graph;
}

/** Transition a graph draft → active. Returns a copy; the input is untouched. */
export function activateGraph(graph: RevenueGraph): RevenueGraph {
  if (graph.status !== 'draft') {
    fail(`cannot activate graph "${graph.id}" from status "${graph.status}" (expected draft)`);
  }
  const next = clone(graph);
  next.status = 'active';
  return next;
}

/**
 * Ingest one event through an adapter and evaluate each resulting event
 * against the graph. Accepts either a canonical EconomicEvent or
 * { adapter, raw } (the adapter runs first). Touch events produced by an
 * adapter cannot be evaluated — ingest them via eventStore.appendTouch.
 */
export function processEvent(
  engine: EvaluationEngine,
  graph: RevenueGraph,
  deps: EngineDeps,
  input: EconomicEvent | RawAdapterInput,
): EvaluationResult[] {
  const raw: Array<EconomicEvent | TouchEvent> = isAdapterInput(input)
    ? input.adapter.toEvents(input.raw)
    : [input];
  const events: EconomicEvent[] = raw.map((e) => {
    if (!isEconomicEvent(e)) {
      fail(
        `adapter "${isAdapterInput(input) ? input.adapter.kind : '?'}" produced a touch event ` +
          '(eventId ' +
          `${(e as TouchEvent).eventId}) — touch events cannot be evaluated; ` +
          'ingest them via eventStore.appendTouch',
      );
    }
    return e;
  });
  for (const event of events) {
    if (event.graphId !== graph.id) {
      fail(
        `event graphId "${event.graphId}" does not match graph "${graph.id}" — ` +
          'adapters are configured per graph',
      );
    }
  }
  return events.map((event) => engine.evaluate(graph, event, deps));
}

/** Filtered read over a ledger. All filter fields are optional conjunctions. */
export function readLedger(
  ledger: Ledger,
  filter: {
    graphId?: string;
    eventId?: string;
    participantId?: string;
    type?: LedgerEntryType;
  },
): LedgerEntry[] {
  return ledger.entries().filter((entry) => {
    if (filter.graphId !== undefined && entry.graphId !== filter.graphId) return false;
    if (filter.eventId !== undefined && entry.eventId !== filter.eventId) return false;
    if (filter.participantId !== undefined && entry.participantId !== filter.participantId)
      return false;
    if (filter.type !== undefined && entry.type !== filter.type) return false;
    return true;
  });
}

function formatAmount(micros: number, currency?: string): string {
  const major = (micros / 1_000_000).toFixed(2);
  if (!currency || currency === 'USD') return `$${major}`;
  return `${major} ${currency}`;
}

/**
 * Human-readable lines for a simulation result — the "paste an event, see
 * the money move" view. Currency is optional; USD renders with $.
 */
export function formatSimulation(result: EvaluationResult, currency?: string): string[] {
  const lines: string[] = [];
  lines.push(
    `simulate ${result.eventId} (graph ${result.graphId} v${result.graphVersion})` +
      (result.idempotentReplay ? ' — REPLAY (no new entries)' : ''),
  );
  for (const e of result.entitlements) {
    lines.push(
      `${e.participantId} ← ${formatAmount(e.amountMicros, currency)} (${e.reason}) [rule ${e.ruleId}]`,
    );
  }
  for (const f of result.fees) {
    lines.push(`${f.kind} fee ${formatAmount(f.amountMicros, currency)} — ${f.reason}`);
  }
  for (const s of result.skipped) {
    lines.push(`skipped ${s.ruleId}: ${s.reason}`);
  }
  if (result.entitlements.length === 0 && result.fees.length === 0 && result.skipped.length === 0) {
    lines.push('(no entitlements, fees, or skips)');
  }
  return lines;
}

export interface SimulationSummary {
  entitlements: Entitlement[];
  fees: ComputedFee[];
  skipped: Array<{ ruleId: string; reason: string }>;
  /** All human-readable explanations: entitlement reasons, fee reasons, skip reasons. */
  explanations: string[];
  /** formatSimulation(result, event.currency) — ready to print. */
  lines: string[];
}

/**
 * Dry-run an event: delegates to engine.simulate, which MUST NOT append to
 * the ledger or mutate state. Returns the computed result plus a
 * human-readable rendering.
 */
export function simulateEvent(
  engine: EvaluationEngine,
  graph: RevenueGraph,
  deps: EngineDeps,
  event: EconomicEvent,
): SimulationSummary {
  if (event.graphId !== graph.id) {
    fail(`event graphId "${event.graphId}" does not match graph "${graph.id}"`);
  }
  const result = engine.simulate(graph, event, deps);
  const explanations: string[] = [
    ...result.entitlements.map((e) => e.reason),
    ...result.fees.map((f) => f.reason),
    ...result.skipped.map((s) => `${s.ruleId}: ${s.reason}`),
  ];
  return {
    entitlements: result.entitlements,
    fees: result.fees,
    skipped: result.skipped,
    explanations,
    lines: formatSimulation(result, event.currency),
  };
}

/**
 * Propose a rule change: sets the pending change on a COPY of the graph.
 * Throws if a change is already pending (approve or withdraw it first).
 * Canonical gate logic lives in graph.ts (full rule validation); this
 * wrapper keeps the SDK's immutable-copy semantics by delegating on a clone.
 */
export function proposeRuleChange(graph: RevenueGraph, proposal: RuleChangeProposal): RevenueGraph {
  if (graph.pendingChange) {
    fail(
      `a rule change proposed by ${graph.pendingChange.proposedBy} is already pending — ` +
        'it must be approved or withdrawn before proposing another',
    );
  }
  if (!proposal.proposedBy) fail('proposal is missing proposedBy');
  const next = clone(graph);
  canonicalProposeRuleChange(next, proposal.proposedBy, clone(proposal.rules), proposal.note);
  return next;
}

/**
 * Approve a pending rule change — owner only. The graph owner is the
 * participant carrying the 'owner' role. Bumps the version, records the new
 * version, clears the pending change. Changes apply to future events only.
 * Returns a copy; the input is untouched. Canonical gate logic lives in
 * graph.ts; this wrapper resolves the owner and delegates on a clone.
 */
export function approveRuleChange(graph: RevenueGraph, approval: RuleChangeApproval): RevenueGraph {
  const owner = graph.participants.find((p) => p.roles.includes('owner'));
  if (!owner) fail(`graph "${graph.id}" has no participant with the 'owner' role`);
  if (approval.approvedBy !== owner.id) {
    fail(
      `only the graph owner (${owner.id}) can approve rule changes — ` +
        `"${approval.approvedBy}" is not authorized`,
    );
  }
  const next = clone(graph);
  canonicalApproveRuleChange(next, approval.approvedBy, owner.id);
  return next;
}
