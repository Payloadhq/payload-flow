/**
 * Payload Flow MVP — domain model and module contracts.
 *
 * This file is the integration surface. Every module implements against these
 * types; nothing here may carry industry-specific assumptions (no music, film,
 * SaaS, or crypto concepts). Industries are configurations built from these
 * primitives, never branches in the engine.
 *
 * MONEY: all amounts are integers in MICRO-UNITS (1e-6 of the major unit).
 * USD 1.00 = 1_000_000. This keeps every calculation exact — no floats.
 * Percentages are integer basis points (1.00% = 100 bps).
 */

export type Micros = number; // integer micro-units; treat as opaque
export type BasisPoints = number; // integer; 100 bps = 1%

/** Payment rail an event arrived on / a payout goes out on. */
export type Rail = 'stripe' | 'ach' | 'x402' | 'manual' | 'stablecoin';
// 'stablecoin': MODELED BUT NOT EXECUTED in v1 — schema only, counsel-gated.

/** Canonical economic event types. TOUCH is a zero-amount event used for
 *  attribution lookback (the engine never tracks clicks; it adjudicates claims
 *  over ingested touch events). */
export type EventType =
  | 'SALE_COMPLETED'
  | 'API_PAYMENT'
  | 'LICENSE_PAID'
  | 'SUBSCRIPTION_PAYMENT'
  | 'REFERRAL_CONVERTED'
  | 'ROYALTY_RECEIVED'
  | 'CAMPAIGN_MILESTONE'
  | 'MARKETPLACE_TRANSACTION'
  | 'TOUCH';

/** How attribution was determined for an event. v1 executes first_touch and
 *  last_touch. weighted is MODELED BUT NOT EXECUTED. */
export type AttributionModel = 'first_touch' | 'last_touch' | 'weighted';

export interface AttributionClaim {
  referrerId?: string;
  campaignId?: string;
  touchEventIds?: string[];
  model?: AttributionModel;
  /** weighted model: MODELED BUT NOT EXECUTED in v1. */
  weights?: Record<string, number>;
}

/** Canonical economic event envelope. Adapters translate source-native
 *  payloads into exactly this shape and nothing more. */
export interface EconomicEvent {
  eventId: string; // globally unique; the idempotency key
  graphId: string;
  type: EventType;
  occurredAt: string; // ISO 8601
  amountMicros: Micros; // integer >= 0 (TOUCH events carry 0)
  currency: string; // ISO 4217 code or token code, e.g. 'USD', 'USDC'
  rail: Rail;
  processingCostMicros: Micros; // rail cost reported by the adapter; fee engine is rail-aware from this
  usageUnits?: number; // e.g. API calls, tokens, seats — unit-agnostic
  attribution?: AttributionClaim;
  territory?: string; // ISO 3166 where relevant
  /**
   * Derivation lineage: what this revenue derives from — an asset, agreement,
   * or upstream project reference (opaque string, e.g. 'asset:track-042' or a
   * graph/project id). Enables downstream/derivative entitlements: rules scope
   * to derived revenue via RuleCondition.derivedFrom. Rail-independent.
   */
  derivedFrom?: string;
  raw: Record<string, unknown>; // source-native payload, retained for audit
}

export interface TouchEvent {
  eventId: string;
  graphId: string;
  occurredAt: string;
  referrerId: string;
  campaignId?: string;
  raw: Record<string, unknown>;
}

export type ParticipantKind = 'person' | 'company' | 'agent';

export interface PayoutDestination {
  rail: Rail;
  /** Bank account reference, wallet address, etc. Never a raw secret. */
  address: string;
  label?: string;
}

export interface Participant {
  id: string;
  kind: ParticipantKind;
  /** Economic roles, e.g. 'owner' | 'contributor' | 'referrer' | 'licensor' | 'lender' | 'platform'. */
  roles: string[];
  identityRef?: string;
  payoutDestinations: PayoutDestination[];
  taxProfileRef?: string; // tax filing itself is partner-owned; we only hold the reference
  /**
   * Separated attributes — never inferred from each other:
   * ownership = who owns what; credit = authorship/attribution;
   * entitlement = contractual payment right (computed by rules, not stored here).
   * MODELED (schema) in v1; ownership/credit are not executed by the engine.
   */
  ownership?: { basis: string; shareBps?: BasisPoints };
  credit?: { statement: string };
}

export interface RevenueSource {
  id: string;
  /** Adapter kind: 'stripe' | 'x402' | 'csv' | 'manual'. The engine never branches on this. */
  kind: string;
  config: Record<string, unknown>;
  eventTypes: EventType[];
}

/** Generic state predicate for conditional rule activation. Evaluated against
 *  the graph's state store: stateKey names a (ruleId, participantId, key)
 *  variable, e.g. 'recoupment.remaining'. */
export interface StatePredicate {
  stateKey: string;
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';
  value: number;
}

/** Generic event matcher. Rules opt into the events they apply to. */
export interface RuleCondition {
  eventTypes?: EventType[];
  minAmountMicros?: Micros;
  maxAmountMicros?: Micros;
  territories?: string[];
  rails?: Rail[];
  /** When true, the rule is skipped (with a recorded reason) if the event
   *  carries no attribution claim naming a referrer. */
  requireAttribution?: boolean;
  /** Stateful activation, e.g. a rule that only fires after a threshold. */
  activeWhen?: StatePredicate;
  /**
   * Downstream/derivative scope: the rule applies only to events whose
   * derivedFrom lineage names one of these references (downstream licensing,
   * resale, derivative works, etc.). Rail-independent.
   */
  derivedFrom?: string[];
  /** LICENSE registry conditions: MODELED BUT NOT EXECUTED in v1. */
  licenseRef?: string;
}

export type RuleType =
  | 'percentage'
  | 'fixed'
  | 'per_use'
  | 'referral'
  | 'recoupment'
  | 'waterfall' // composite: expands to ordered primitive rules at validation time
  | 'capped' // wrapper: inner rule subject to a cumulative cap
  | 'time_limited' // wrapper: inner rule active only within [effectiveFrom, effectiveTo]
  | 'milestone' // wrapper: inner rule activates on trigger; v1 = manual trigger only (oracles modeled, not executed)
  | 'attribution' // first/last-touch determination over ingested touch events
  | 'remainder' // exactly one per graph; lowest priority; takes pool remainder
  | 'payload_fee' // computed by the fee engine
  | 'platform_fee'; // the embedding customer's own fee, a first-class rule

export interface PercentageParams { rateBps: BasisPoints; subjectParticipantId: string; }
export interface FixedParams { amountMicros: Micros; subjectParticipantId: string; }
export interface PerUseParams { rateMicrosPerUnit: Micros; subjectParticipantId: string; }
export interface ReferralParams { rateBps: BasisPoints; } // subject resolved from event.attribution.referrerId
export interface RecoupmentParams {
  subjectParticipantId: string;
  advanceMicros: Micros;
  recoupRateBps: BasisPoints;
  postRateBps: BasisPoints;
  /** Cross-release collateralization etc. — generic scope key, default = this graph. */
  scope?: string;
}
export interface WaterfallParams {
  tranches: Array<{ subjectParticipantId: string; rateBps: BasisPoints; upToMicros?: Micros }>;
}
export interface CappedParams { inner: Rule; capMicros: Micros; subjectParticipantId: string; }
export interface TimeLimitedParams { inner: Rule; effectiveFrom: string; effectiveTo: string; }
export interface MilestoneParams {
  inner: Rule;
  trigger: 'manual'; // oracle triggers: MODELED BUT NOT EXECUTED
  description: string;
}
export interface AttributionParams {
  model: 'first_touch' | 'last_touch'; // 'weighted': MODELED BUT NOT EXECUTED
  windowDays: number;
  rateBps: BasisPoints;
}
export interface RemainderParams { subjectParticipantId: string; }
export interface PayloadFeeParams { licenseTier: LicenseTier; }
export interface PlatformFeeParams { rateBps: BasisPoints; subjectParticipantId: string; }

export type RuleParams =
  | PercentageParams | FixedParams | PerUseParams | ReferralParams
  | RecoupmentParams | WaterfallParams | CappedParams | TimeLimitedParams
  | MilestoneParams | AttributionParams | RemainderParams | PayloadFeeParams
  | PlatformFeeParams;

export interface Rule {
  id: string;
  type: RuleType;
  /** Lower priority evaluates earlier. Rules consume from the pool sequentially. */
  priority: number;
  params: RuleParams;
  conditions?: RuleCondition;
  /** Versioning: changes apply to future events only. */
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface Entitlement {
  eventId: string;
  graphId: string;
  graphVersion: number;
  ruleId: string;
  participantId: string;
  amountMicros: Micros;
  /** Human-readable explanation, e.g. "6% of net $96.70". */
  reason: string;
}

export type LedgerEntryType = 'ENTITLEMENT' | 'FEE' | 'SKIPPED' | 'REVERSAL' | 'VERSION' | 'CONTRIBUTION';

export interface LedgerEntry {
  seq: number;
  at: string;
  eventId: string;
  graphId: string;
  graphVersion: number;
  type: LedgerEntryType;
  ruleId?: string;
  participantId?: string;
  amountMicros?: Micros;
  /** Why this entry exists — links event → graph version → rule. */
  reason: string;
  prevHash: string;
  hash: string;
}

/** CONTRIBUTION graph: MODELED BUT NOT EXECUTED in v1 — auto-written from
 *  executions, no verification UX. */
export interface Contribution {
  graphId: string;
  participantId: string;
  role: string;
  eventId: string;
  at: string;
}

export interface Distribution {
  /** A payout INSTRUCTION for a regulated partner / facilitator. The engine
   *  builds these; it never executes them and never holds the funds. */
  instructionId: string;
  graphId: string;
  eventId: string;
  participantId: string;
  destination: PayoutDestination;
  amountMicros: Micros;
  currency: string;
  rail: Rail;
  status: 'proposed';
}

export interface GraphVersionRecord {
  version: number;
  rules: Rule[];
  changedBy: string;
  approvedBy?: string;
  at: string;
  note?: string;
}

export interface PendingChange {
  proposedBy: string;
  at: string;
  note?: string;
  rules: Rule[];
}

/**
 * Revenue Graph — persistent, versioned, industry-neutral.
 * Rule changes create new versions; history is immutable. Material changes
 * require owner approval (modeled by the pending-change gate).
 */
export interface RevenueGraph {
  id: string;
  projectId: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  participants: Participant[];
  revenueSources: RevenueSource[];
  rules: Rule[];
  versions: GraphVersionRecord[];
  pendingChange?: PendingChange;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

/** License tiers for pricing engine v2. */
export type LicenseTier = 'free' | 'builder' | 'pro' | 'platform' | 'enterprise';

export interface License {
  accountId: string;
  tier: LicenseTier;
  /** Enterprise negotiated multiplier; undefined for other tiers. */
  enterpriseRateMultiplier?: number;
  grantedAt: string;
}

/** PlatformFee / PayloadFee are computed per event; the ledger records them.
 *  These interfaces describe the computed values (system rules). */
export interface ComputedFee {
  kind: 'platform_fee' | 'payload_fee';
  amountMicros: Micros;
  rateBps: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Module contracts
// ---------------------------------------------------------------------------

/** Result of evaluating one event against a graph. */
export interface EvaluationResult {
  eventId: string;
  graphId: string;
  graphVersion: number;
  entitlements: Entitlement[];
  fees: ComputedFee[];
  skipped: Array<{ ruleId: string; reason: string }>;
  distributions: Distribution[];
  /** True when this eventId was already processed: prior result returned, no double-count. */
  idempotentReplay: boolean;
}

/** First-class queryable event log. Adapters append; the engine queries
 *  (attribution lookback needs this). Never a fire-and-forget pipe. */
export interface EventStore {
  append(event: EconomicEvent | TouchEvent): void;
  appendTouch(touch: TouchEvent): void;
  getEvent(eventId: string): (EconomicEvent | TouchEvent) | undefined;
  /** Query touch events for attribution determination. */
  queryTouches(filter: {
    graphId: string;
    referrerId?: string;
    campaignId?: string;
    from?: string;
    to?: string;
  }): TouchEvent[];
  queryEvents(filter: { graphId: string; type?: EventType; from?: string; to?: string }): EconomicEvent[];
}

/** Stateful per-graph variables: recoupment balances, cumulative caps,
 *  cumulative counters, milestone triggers, fee-allowance consumption. */
export interface StateStore {
  get(graphId: string, ruleId: string, participantId: string, key: string): number | undefined;
  set(graphId: string, ruleId: string, participantId: string, key: string, value: number): void;
  /** Atomically add delta and return the new value. */
  add(graphId: string, ruleId: string, participantId: string, key: string, delta: number): number;
}

/** Append-only hash-chained ledger. */
export interface Ledger {
  append(entry: Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'at'>): LedgerEntry;
  entries(): LedgerEntry[];
  entriesForEvent(eventId: string): LedgerEntry[];
  entriesForGraph(graphId: string): LedgerEntry[];
  /** Recomputes the chain; returns false at the first broken link. */
  verifyChain(): boolean;
}

export interface EngineDeps {
  eventStore: EventStore;
  stateStore: StateStore;
  ledger: Ledger;
  feeEngine: FeeEngine;
  /** Account context for the payload_fee rule. Volume is recorded by the
   *  engine after each successfully routed (non-replay) evaluation. */
  accounting: { accountId: string; license: License };
}

/**
 * Evaluate one event against a graph's ACTIVE rule version.
 * Deterministic: same event + same graph version → same entitlements.
 * Idempotent: re-delivery of an eventId returns the prior result.
 */
export interface EvaluationEngine {
  evaluate(graph: RevenueGraph, event: EconomicEvent, deps: EngineDeps): EvaluationResult;
  /** Dry-run: compute entitlements WITHOUT appending to ledger/state ("paste an event, see the money move"). */
  simulate(graph: RevenueGraph, event: EconomicEvent, deps: EngineDeps): EvaluationResult;
  /** Manual milestone trigger (v1 only trigger kind). */
  triggerMilestone(graph: RevenueGraph, ruleId: string, triggeredBy: string): void;
}

/** Trailing-30-day net volume tracker, per account. */
export interface VolumeTracker {
  record(accountId: string, at: string, netMicros: Micros): void;
  trailing30dNetMicros(accountId: string, at: string): Micros;
  lifetimeNetMicros(accountId: string): Micros;
}

export interface FeeEngine {
  /**
   * fee = max(rail_floor[rail], rate(trailing30dNet, tier) × net),
   * net = amount − processingCost, assessed only on successfully routed value.
   * Free tier: first $1,000 lifetime net at 0%.
   * Pure computation — does NOT record volume (see recordVolume).
   */
  computeFee(args: {
    amountMicros: Micros;
    processingCostMicros: Micros;
    rail: Rail;
    accountId: string;
    license: License;
    at: string;
  }): { feeMicros: Micros; rateBps: number; netMicros: Micros; tier: LicenseTier };
  /** Record successfully routed net volume (called by the engine after a
   *  non-replay evaluation; never called by simulate/dry-run). */
  recordVolume(accountId: string, at: string, netMicros: Micros): void;
}

/** Adapter: translates a source-native payload into canonical envelope(s).
 *  Translation ONLY — adapters never evaluate rules or move money. */
export interface Adapter {
  kind: string;
  toEvents(input: unknown): Array<EconomicEvent | TouchEvent>;
}

/** Webhooks-out event types. */
export type WebhookEventType =
  | 'entitlement.calculated'
  | 'payout.instructed'
  | 'payout.settled'
  | 'payout.failed'
  | 'rule.versioned';

export interface WebhookEvent {
  type: WebhookEventType;
  at: string;
  graphId: string;
  eventId?: string;
  payload: Record<string, unknown>;
}

export interface WebhookEmitter {
  emit(event: WebhookEvent): void;
  emitted(): WebhookEvent[];
}

/** Partner settlement report line (what the regulated partner says settled). */
export interface SettlementReportLine {
  instructionId: string;
  status: 'settled' | 'failed';
  settledAmountMicros?: Micros;
  at: string;
}

export interface ReconciliationException {
  instructionId: string;
  kind: 'missing_settlement' | 'amount_mismatch' | 'unexpected_settlement';
  detail: string;
  at: string;
}

export interface Reconciler {
  /** Compare distributions (instructions) against a partner report; queue exceptions. */
  reconcile(distributions: Distribution[], report: SettlementReportLine[]): ReconciliationException[];
  exceptions(): ReconciliationException[];
}
