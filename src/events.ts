/**
 * events.ts — strict validation of the canonical economic event envelope.
 *
 * Adapters translate source-native payloads into exactly the EconomicEvent /
 * TouchEvent shape; this module is the gate that proves they did. Validation
 * is strict: every required field is checked for presence AND type, dates must
 * parse, money must be an integer >= 0, and nothing is coerced silently.
 * Anything that fails throws EventValidationError with a descriptive message.
 */
import type {
  AttributionClaim,
  AttributionModel,
  EconomicEvent,
  EventType,
  Rail,
  TouchEvent,
} from './types.js';

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'SALE_COMPLETED',
  'API_PAYMENT',
  'LICENSE_PAID',
  'SUBSCRIPTION_PAYMENT',
  'REFERRAL_CONVERTED',
  'ROYALTY_RECEIVED',
  'CAMPAIGN_MILESTONE',
  'MARKETPLACE_TRANSACTION',
  'TOUCH',
]);

const RAILS: ReadonlySet<string> = new Set<string>([
  'stripe',
  'ach',
  'x402',
  'manual',
  'stablecoin',
]);

const ATTRIBUTION_MODELS: ReadonlySet<string> = new Set<string>([
  'first_touch',
  'last_touch',
  'weighted',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, field: string, what: string): string {
  const v = o[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new EventValidationError(`${what}: '${field}' must be a non-empty string`);
  }
  return v;
}

function optString(o: Record<string, unknown>, field: string, what: string): string | undefined {
  const v = o[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new EventValidationError(`${what}: '${field}' must be a string when present`);
  }
  return v;
}

function reqIsoDate(o: Record<string, unknown>, field: string, what: string): string {
  const s = reqString(o, field, what);
  if (Number.isNaN(Date.parse(s))) {
    throw new EventValidationError(`${what}: '${field}' must be a parseable ISO 8601 date, got '${s}'`);
  }
  return s;
}

function reqMicros(o: Record<string, unknown>, field: string, what: string): number {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new EventValidationError(
      `${what}: '${field}' must be an integer number of micro-units >= 0, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

function reqRaw(o: Record<string, unknown>, what: string): Record<string, unknown> {
  const v = o['raw'];
  if (!isRecord(v)) {
    throw new EventValidationError(`${what}: 'raw' must be an object (source-native payload retained for audit)`);
  }
  return v;
}

function validateAttribution(v: unknown): AttributionClaim | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) {
    throw new EventValidationError(`event: 'attribution' must be an object when present`);
  }
  const claim: AttributionClaim = {};
  if (v['referrerId'] !== undefined) {
    if (typeof v['referrerId'] !== 'string' || v['referrerId'].length === 0) {
      throw new EventValidationError(`event: 'attribution.referrerId' must be a non-empty string when present`);
    }
    claim.referrerId = v['referrerId'];
  }
  if (v['campaignId'] !== undefined) {
    if (typeof v['campaignId'] !== 'string') {
      throw new EventValidationError(`event: 'attribution.campaignId' must be a string when present`);
    }
    claim.campaignId = v['campaignId'];
  }
  if (v['touchEventIds'] !== undefined) {
    if (!Array.isArray(v['touchEventIds']) || !v['touchEventIds'].every((t) => typeof t === 'string')) {
      throw new EventValidationError(`event: 'attribution.touchEventIds' must be a string array when present`);
    }
    claim.touchEventIds = v['touchEventIds'] as string[];
  }
  if (v['model'] !== undefined) {
    if (typeof v['model'] !== 'string' || !ATTRIBUTION_MODELS.has(v['model'])) {
      throw new EventValidationError(
        `event: 'attribution.model' must be one of ${[...ATTRIBUTION_MODELS].join(', ')}`,
      );
    }
    claim.model = v['model'] as AttributionModel;
  }
  if (v['weights'] !== undefined) {
    if (!isRecord(v['weights'])) {
      throw new EventValidationError(`event: 'attribution.weights' must be an object when present`);
    }
    claim.weights = v['weights'] as Record<string, number>;
  }
  return claim;
}

/**
 * Strictly validate an unknown value as an EconomicEvent. Returns a canonical
 * envelope carrying only known fields (unknown extras are dropped, never
 * coerced). TOUCH events must carry amountMicros 0.
 */
export function validateEvent(e: unknown): EconomicEvent {
  if (!isRecord(e)) {
    throw new EventValidationError('event must be an object');
  }
  const type = reqString(e, 'type', 'event');
  if (!EVENT_TYPES.has(type)) {
    throw new EventValidationError(
      `event: unknown type '${type}'; expected one of ${[...EVENT_TYPES].join(', ')}`,
    );
  }
  const eventType = type as EventType;

  const rail = reqString(e, 'rail', 'event');
  if (!RAILS.has(rail)) {
    throw new EventValidationError(`event: unknown rail '${rail}'; expected one of ${[...RAILS].join(', ')}`);
  }

  const amountMicros = reqMicros(e, 'amountMicros', 'event');
  if (eventType === 'TOUCH' && amountMicros !== 0) {
    throw new EventValidationError(
      `event: TOUCH events are zero-amount attribution markers; amountMicros must be 0, got ${amountMicros}`,
    );
  }

  let usageUnits: number | undefined;
  if (e['usageUnits'] !== undefined) {
    const u = e['usageUnits'];
    if (typeof u !== 'number' || !Number.isFinite(u) || u < 0) {
      throw new EventValidationError(
        `event: 'usageUnits' must be a finite number >= 0 when present, got ${JSON.stringify(u)}`,
      );
    }
    usageUnits = u;
  }

  const event: EconomicEvent = {
    eventId: reqString(e, 'eventId', 'event'),
    graphId: reqString(e, 'graphId', 'event'),
    type: eventType,
    occurredAt: reqIsoDate(e, 'occurredAt', 'event'),
    amountMicros,
    currency: reqString(e, 'currency', 'event'),
    rail: rail as Rail,
    processingCostMicros: reqMicros(e, 'processingCostMicros', 'event'),
    raw: reqRaw(e, 'event'),
  };
  if (usageUnits !== undefined) event.usageUnits = usageUnits;
  const attribution = validateAttribution(e['attribution']);
  if (attribution !== undefined) event.attribution = attribution;
  const territory = optString(e, 'territory', 'event');
  if (territory !== undefined) event.territory = territory;
  const derivedFrom = optString(e, 'derivedFrom', 'event');
  if (derivedFrom !== undefined) event.derivedFrom = derivedFrom;
  return event;
}

/** Strictly validate an unknown value as a TouchEvent (zero-amount marker). */
export function validateTouchEvent(t: unknown): TouchEvent {
  if (!isRecord(t)) {
    throw new EventValidationError('touch event must be an object');
  }
  const touch: TouchEvent = {
    eventId: reqString(t, 'eventId', 'touch event'),
    graphId: reqString(t, 'graphId', 'touch event'),
    occurredAt: reqIsoDate(t, 'occurredAt', 'touch event'),
    referrerId: reqString(t, 'referrerId', 'touch event'),
    raw: reqRaw(t, 'touch event'),
  };
  const campaignId = optString(t, 'campaignId', 'touch event');
  if (campaignId !== undefined) touch.campaignId = campaignId;
  return touch;
}
