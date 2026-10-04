/**
 * rules.ts — rule-graph validation and composite expansion.
 *
 * validateGraph(graph) -> string[]: returns the list of validation errors;
 * an empty list means the graph is valid. It enforces:
 *   - rule ids are unique (top-level, nested wrapper inners, expanded tranches)
 *   - exactly one `remainder` rule exists and it has the lowest priority
 *     (strictly the highest priority number — it must evaluate last)
 *   - every static subjectParticipantId resolves to a graph participant
 *   - waterfall composites expand to ordered percentage rules before checks
 *   - basic per-type param sanity (rates within 0..10000 bps, non-negative
 *     micros, valid ISO windows, known license tiers)
 *   - wrapper rules (capped/time_limited/milestone) wrap a primitive
 *     allocation rule; waterfall composites cannot be nested inside wrappers
 *
 * expandWaterfall(rule, siblings): a `waterfall` rule's tranches become ordered
 * `percentage` rules. Each tranche keeps its per-event cap as `upToMicros`
 * attached to the expanded rule's params — a documented runtime extension of
 * PercentageParams (types.ts is untouched; the engine reads it). Tranche
 * priorities are interpolated strictly between the waterfall's neighboring
 * top-level priorities so the tranches take the waterfall's exact slot in
 * evaluation order, in tranche order.
 *
 * expandRule(rule): waterfall -> N rules; everything else -> [rule].
 * expandAllRules(rules): expandRule over a top-level list (passing siblings so
 * waterfall interpolation sees the real neighbors).
 *
 * Referral default: referral rules default requireAttribution=true. This is
 * applied by the engine at condition-check time (see engine.ts), not as a
 * validation error — an explicit requireAttribution:false is legal config.
 */
import type {
  AttributionParams,
  CappedParams,
  FixedParams,
  LicenseTier,
  MilestoneParams,
  PercentageParams,
  PerUseParams,
  PlatformFeeParams,
  RecoupmentParams,
  ReferralParams,
  RemainderParams,
  RevenueGraph,
  Rule,
  RuleType,
  TimeLimitedParams,
  WaterfallParams,
} from './types.js';

const WRAPPER_TYPES: ReadonlySet<RuleType> = new Set<RuleType>(['capped', 'time_limited', 'milestone']);

/** Primitive allocation rules that wrappers may wrap. */
const WRAPPABLE_TYPES: ReadonlySet<RuleType> = new Set<RuleType>([
  'percentage',
  'fixed',
  'per_use',
  'referral',
  'recoupment',
  'attribution',
]);

const LICENSE_TIERS: ReadonlySet<string> = new Set<string>([
  'free',
  'builder',
  'pro',
  'platform',
  'enterprise',
]);

/** Unwrap capped/time_limited/milestone to the core rule for type-level checks. */
export function coreRule(rule: Rule): Rule {
  let r = rule;
  while (r.type === 'capped' || r.type === 'time_limited' || r.type === 'milestone') {
    const inner = (r.params as { inner: Rule }).inner;
    r = inner;
  }
  return r;
}

/** Recursively collect the ids of rules nested inside wrappers. */
function collectInnerIds(rule: Rule, into: Array<{ id: string; where: string }>): void {
  if (WRAPPER_TYPES.has(rule.type)) {
    const inner = (rule.params as { inner: Rule }).inner;
    into.push({ id: inner.id, where: `inner of '${rule.id}'` });
    collectInnerIds(inner, into);
  }
}

/**
 * Expand a waterfall rule into ordered percentage rules.
 * @param siblings the waterfall's top-level sibling rules (used to interpolate
 *   tranche priorities between the nearest lower and higher neighbor priorities)
 */
export function expandWaterfall(rule: Rule, siblings: Rule[] = []): Rule[] {
  if (rule.type !== 'waterfall') {
    throw new Error(`expandWaterfall: rule '${rule.id}' is type '${rule.type}', not 'waterfall'`);
  }
  const params = rule.params as WaterfallParams;
  const tranches = params.tranches;
  if (!Array.isArray(tranches) || tranches.length === 0) {
    throw new Error(`expandWaterfall: waterfall rule '${rule.id}' must declare at least one tranche`);
  }
  for (let i = 0; i < tranches.length; i++) {
    const t = tranches[i]!;
    if (!Number.isInteger(t.rateBps) || t.rateBps < 0 || t.rateBps > 10000) {
      throw new Error(
        `expandWaterfall: tranche ${i} of rule '${rule.id}' has invalid rateBps ${String(t.rateBps)} (must be an integer 0..10000)`,
      );
    }
    if (t.upToMicros !== undefined && (!Number.isInteger(t.upToMicros) || t.upToMicros < 0)) {
      throw new Error(
        `expandWaterfall: tranche ${i} of rule '${rule.id}' has invalid upToMicros ${String(t.upToMicros)} (must be an integer >= 0)`,
      );
    }
  }

  const n = tranches.length;
  const otherPriorities = siblings.filter((r) => r.id !== rule.id).map((r) => r.priority);
  const lower = otherPriorities.filter((p) => p < rule.priority);
  const higher = otherPriorities.filter((p) => p > rule.priority);
  const lo =
    lower.length > 0
      ? Math.max(...lower)
      : higher.length > 0
        ? Math.min(...higher) - (n + 1)
        : rule.priority - (n + 1);
  const hi =
    higher.length > 0
      ? Math.min(...higher)
      : lower.length > 0
        ? Math.max(...lower) + (n + 1)
        : rule.priority + (n + 1);

  return tranches.map((t, i) => {
    const priority = lo + ((hi - lo) * (i + 1)) / (n + 1);
    const p: PercentageParams & { upToMicros?: number } = {
      rateBps: t.rateBps,
      subjectParticipantId: t.subjectParticipantId,
    };
    if (t.upToMicros !== undefined) p.upToMicros = t.upToMicros;
    const expanded: Rule = {
      id: `${rule.id}#tranche${i}`,
      type: 'percentage',
      priority,
      params: p,
    };
    if (rule.conditions !== undefined) expanded.conditions = rule.conditions;
    if (rule.effectiveFrom !== undefined) expanded.effectiveFrom = rule.effectiveFrom;
    if (rule.effectiveTo !== undefined) expanded.effectiveTo = rule.effectiveTo;
    return expanded;
  });
}

/** waterfall -> N rules; everything else -> [rule]. */
export function expandRule(rule: Rule): Rule[] {
  if (rule.type === 'waterfall') return expandWaterfall(rule);
  return [rule];
}

/** Expand every top-level rule (waterfalls interpolate against true neighbors). */
export function expandAllRules(rules: Rule[]): Rule[] {
  const out: Rule[] = [];
  for (const rule of rules) {
    if (rule.type === 'waterfall') out.push(...expandWaterfall(rule, rules));
    else out.push(rule);
  }
  return out;
}

/** Static subject ids referenced by a rule (recurses into wrappers). */
function subjectIds(rule: Rule): string[] {
  switch (rule.type) {
    case 'percentage':
      return [(rule.params as PercentageParams).subjectParticipantId];
    case 'fixed':
      return [(rule.params as FixedParams).subjectParticipantId];
    case 'per_use':
      return [(rule.params as PerUseParams).subjectParticipantId];
    case 'recoupment':
      return [(rule.params as RecoupmentParams).subjectParticipantId];
    case 'remainder':
      return [(rule.params as RemainderParams).subjectParticipantId];
    case 'platform_fee':
      return [(rule.params as PlatformFeeParams).subjectParticipantId];
    case 'capped': {
      const p = rule.params as CappedParams;
      return [p.subjectParticipantId, ...subjectIds(p.inner)];
    }
    case 'time_limited':
      return subjectIds((rule.params as TimeLimitedParams).inner);
    case 'milestone':
      return subjectIds((rule.params as MilestoneParams).inner);
    case 'referral':
    case 'attribution':
    case 'payload_fee':
    case 'waterfall':
      return [];
  }
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isValidIso(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function checkRateBps(v: unknown, what: string, errors: string[]): void {
  if (!isInt(v) || (v as number) < 0 || (v as number) > 10000) {
    errors.push(`${what}: rateBps must be an integer 0..10000, got ${String(v)}`);
  }
}

function checkMicros(v: unknown, what: string, errors: string[]): void {
  if (!isInt(v) || (v as number) < 0) {
    errors.push(`${what}: must be an integer number of micro-units >= 0, got ${String(v)}`);
  }
}

/** Per-type param sanity. Recurses into wrapper inners. */
function checkParams(rule: Rule, errors: string[]): void {
  const what = `rule '${rule.id}' (${rule.type})`;
  const p = rule.params as unknown as Record<string, unknown>;
  switch (rule.type) {
    case 'percentage':
      checkRateBps((p as unknown as PercentageParams).rateBps, what, errors);
      break;
    case 'fixed':
      checkMicros((p as unknown as FixedParams).amountMicros, what, errors);
      break;
    case 'per_use':
      checkMicros((p as unknown as PerUseParams).rateMicrosPerUnit, what, errors);
      break;
    case 'referral':
      checkRateBps((p as unknown as ReferralParams).rateBps, what, errors);
      break;
    case 'recoupment': {
      const rp = p as unknown as RecoupmentParams;
      checkMicros(rp.advanceMicros, `${what}.advanceMicros`, errors);
      checkRateBps(rp.recoupRateBps, `${what}.recoupRateBps`, errors);
      checkRateBps(rp.postRateBps, `${what}.postRateBps`, errors);
      break;
    }
    case 'waterfall': {
      const wp = p as unknown as WaterfallParams;
      if (!Array.isArray(wp.tranches) || wp.tranches.length === 0) {
        errors.push(`${what}: waterfall must declare at least one tranche`);
      } else {
        wp.tranches.forEach((t, i) => {
          checkRateBps(t.rateBps, `${what}.tranches[${i}].rateBps`, errors);
          if (t.upToMicros !== undefined) checkMicros(t.upToMicros, `${what}.tranches[${i}].upToMicros`, errors);
        });
      }
      break;
    }
    case 'capped': {
      const cp = p as unknown as CappedParams;
      checkMicros(cp.capMicros, `${what}.capMicros`, errors);
      checkParams(cp.inner, errors);
      break;
    }
    case 'time_limited': {
      const tp = p as unknown as TimeLimitedParams;
      if (!isValidIso(tp.effectiveFrom) || !isValidIso(tp.effectiveTo)) {
        errors.push(`${what}: effectiveFrom/effectiveTo must be valid ISO dates`);
      } else if (Date.parse(tp.effectiveFrom) >= Date.parse(tp.effectiveTo)) {
        errors.push(`${what}: effectiveFrom must be before effectiveTo`);
      }
      checkParams(tp.inner, errors);
      break;
    }
    case 'milestone': {
      const mp = p as unknown as MilestoneParams;
      if (mp.trigger !== 'manual') {
        errors.push(`${what}: only the 'manual' trigger is executed in v1 (oracles are modeled, not executed)`);
      }
      checkParams(mp.inner, errors);
      break;
    }
    case 'attribution': {
      const ap = p as unknown as AttributionParams;
      if (ap.model !== 'first_touch' && ap.model !== 'last_touch') {
        errors.push(`${what}: only 'first_touch'/'last_touch' are executed in v1 (weighted is modeled, not executed)`);
      }
      if (typeof ap.windowDays !== 'number' || !Number.isFinite(ap.windowDays) || ap.windowDays < 0) {
        errors.push(`${what}: windowDays must be a finite number >= 0`);
      }
      checkRateBps(ap.rateBps, what, errors);
      break;
    }
    case 'remainder':
      break;
    case 'payload_fee': {
      const tier = (p as unknown as { licenseTier: LicenseTier }).licenseTier;
      if (!LICENSE_TIERS.has(tier as string)) {
        errors.push(`${what}: unknown licenseTier '${String(tier)}'`);
      }
      break;
    }
    case 'platform_fee':
      checkRateBps((p as unknown as PlatformFeeParams).rateBps, what, errors);
      break;
  }
}

/**
 * Validate a revenue graph's rule set. Returns the list of errors; an empty
 * list means the graph is valid.
 */
export function validateGraph(graph: RevenueGraph): string[] {
  const errors: string[] = [];
  if (typeof graph !== 'object' || graph === null) return ['graph must be an object'];
  if (!Array.isArray(graph.rules)) return ['graph.rules must be an array'];

  const participantIds = new Set<string>((graph.participants ?? []).map((pt) => pt.id));

  for (const r of graph.rules) {
    if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) {
      errors.push(`rule '${String((r as Rule).id)}': priority must be a finite number`);
    }
    if (r.effectiveFrom !== undefined && !isValidIso(r.effectiveFrom)) {
      errors.push(`rule '${r.id}': effectiveFrom must be a valid ISO date`);
    }
    if (r.effectiveTo !== undefined && !isValidIso(r.effectiveTo)) {
      errors.push(`rule '${r.id}': effectiveTo must be a valid ISO date`);
    }
    if (
      r.effectiveFrom !== undefined &&
      r.effectiveTo !== undefined &&
      isValidIso(r.effectiveFrom) &&
      isValidIso(r.effectiveTo) &&
      Date.parse(r.effectiveFrom) > Date.parse(r.effectiveTo)
    ) {
      errors.push(`rule '${r.id}': effectiveFrom must not be after effectiveTo`);
    }
  }

  // Wrapper nesting rules: no waterfall inside wrappers; wrappers wrap primitives.
  for (const r of graph.rules) {
    let inner: Rule | undefined = WRAPPER_TYPES.has(r.type)
      ? (r.params as { inner: Rule }).inner
      : undefined;
    while (inner) {
      if (inner.type === 'waterfall') {
        errors.push(
          `rule '${r.id}': waterfall composites cannot be nested inside '${r.type}' wrappers; place the waterfall top-level`,
        );
        break;
      }
      if (!WRAPPABLE_TYPES.has(inner.type) && !WRAPPER_TYPES.has(inner.type)) {
        errors.push(`rule '${r.id}': wrapper inner rule must be a primitive allocation rule, got '${inner.type}'`);
        break;
      }
      if (WRAPPABLE_TYPES.has(inner.type)) break;
      inner = (inner.params as { inner: Rule }).inner;
    }
    // A wrapper wrapping a fee or remainder rule has no defined semantics.
    const core = coreRule(r);
    if (WRAPPER_TYPES.has(r.type) && (core.type === 'payload_fee' || core.type === 'platform_fee' || core.type === 'remainder')) {
      errors.push(`rule '${r.id}': '${r.type}' wrappers cannot wrap a '${core.type}' rule`);
    }
  }

  // Expand composites, then run the structural checks on the expanded set.
  let expanded: Rule[];
  try {
    expanded = expandAllRules(graph.rules);
  } catch (err) {
    return [...errors, `rule expansion failed: ${(err as Error).message}`];
  }

  // Unique ids across top-level, nested inners, and expanded tranches.
  const seen = new Map<string, string>();
  const claim = (id: string, where: string): void => {
    const prev = seen.get(id);
    if (prev !== undefined) {
      errors.push(`duplicate rule id '${id}' (${prev} vs ${where})`);
    } else {
      seen.set(id, where);
    }
  };
  for (const r of graph.rules) {
    claim(r.id, 'top-level rule');
    for (const inner of collectInnerIdList(r)) claim(inner.id, inner.where);
  }
  const topLevel = new Set<Rule>(graph.rules);
  for (const r of expanded) {
    if (!topLevel.has(r)) claim(r.id, 'expanded waterfall tranche');
  }

  // Exactly one remainder, and it evaluates last (strictly highest priority number).
  const remainders = graph.rules.filter((r) => coreRule(r).type === 'remainder');
  if (remainders.length !== 1) {
    errors.push(`graph must contain exactly one 'remainder' rule; found ${remainders.length}`);
  } else {
    const rem = remainders[0]!;
    for (const r of graph.rules) {
      if (r.id !== rem.id && r.priority >= rem.priority) {
        errors.push(
          `remainder rule '${rem.id}' must have the lowest priority (highest number); rule '${r.id}' has priority ${r.priority} >= ${rem.priority}`,
        );
      }
    }
  }

  // Every static subject must resolve to a graph participant.
  for (const r of expanded) {
    for (const pid of subjectIds(r)) {
      if (pid === undefined || !participantIds.has(pid)) {
        errors.push(`rule '${r.id}': subject participant '${String(pid)}' is not a graph participant`);
      }
    }
  }

  // Per-type param sanity on top-level rules (recurses into wrappers).
  for (const r of graph.rules) checkParams(r, errors);

  // Condition sanity.
  for (const r of graph.rules) {
    const c = r.conditions;
    if (!c) continue;
    if (
      c.minAmountMicros !== undefined &&
      c.maxAmountMicros !== undefined &&
      c.minAmountMicros > c.maxAmountMicros
    ) {
      errors.push(`rule '${r.id}': conditions.minAmountMicros > conditions.maxAmountMicros`);
    }
    if (
      c.derivedFrom !== undefined &&
      (!Array.isArray(c.derivedFrom) ||
        c.derivedFrom.length === 0 ||
        !c.derivedFrom.every((d) => typeof d === 'string' && d.length > 0))
    ) {
      errors.push(`rule '${r.id}': conditions.derivedFrom must be a non-empty string array when present`);
    }
  }

  return errors;
}

function collectInnerIdList(rule: Rule): Array<{ id: string; where: string }> {
  const out: Array<{ id: string; where: string }> = [];
  collectInnerIds(rule, out);
  return out;
}
