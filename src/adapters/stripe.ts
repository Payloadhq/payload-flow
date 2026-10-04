/**
 * Stripe adapter — translates Stripe payment webhooks into canonical
 * economic events.
 *
 * TRANSLATION ONLY: this module never evaluates rules, never moves money,
 * and never calls a live payment API. It converts a Stripe webhook payload
 * into the canonical {@link EconomicEvent} envelope and nothing more.
 *
 * Scope (v1):
 * - Translates `payment_intent.succeeded` → `SALE_COMPLETED`.
 * - Everything else throws `unsupported webhook type`. In particular,
 *   `charge.refunded` is NOT mapped here: refunds are REVERSAL ledger
 *   entries, which live at the engine level and are out of adapter scope.
 * - USD-major: non-USD currencies pass through with no FX conversion (a note
 *   is retained in `raw`; multi-currency netting is not yet modeled).
 * - Amounts: Stripe `amount_received` is in cents → × 10_000 = micros.
 */

import type {
  Adapter,
  AttributionClaim,
  EconomicEvent,
  Micros,
  Rail,
} from '../types.js';

/** How the rail cost is computed for an event. */
export interface StripeProcessingCost {
  /** Fee rate in basis points (100 bps = 1%). */
  rateBps: number;
  /** Fixed per-event fee in micros. */
  fixedMicros: Micros;
}

/**
 * DEFAULT (an assumption, overridable): 290 bps + 300_000 micros ($0.30),
 * the standard US online card rate. Hosts in other regions or on other
 * Stripe pricing should override this explicitly.
 */
export const DEFAULT_STRIPE_PROCESSING_COST: StripeProcessingCost = {
  rateBps: 290,
  fixedMicros: 300_000,
};

export interface StripeAdapterConfig {
  /** Graph the translated events belong to. */
  graphId: string;
  /** Rail-cost model applied to every event (default: documented assumption above). */
  processingCost?: StripeProcessingCost;
}

const SUPPORTED_TYPE = 'payment_intent.succeeded';

function fail(message: string): never {
  throw new Error(`stripe adapter: ${message}`);
}

function parsePayload(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the descriptive error below
    }
    fail('input must be a Stripe webhook JSON object or a JSON string of one');
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  fail('input must be a Stripe webhook JSON object or a JSON string of one');
}

function strField(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export function createStripeAdapter(config: StripeAdapterConfig = { graphId: '' }): Adapter {
  const graphId = config.graphId;
  const cost: StripeProcessingCost = config.processingCost ?? DEFAULT_STRIPE_PROCESSING_COST;

  return {
    kind: 'stripe',

    toEvents(input: unknown): EconomicEvent[] {
      const payload = parsePayload(input);
      const type = strField(payload, 'type') ?? '(missing)';

      if (type !== SUPPORTED_TYPE) {
        fail(
          `unsupported webhook type "${type}" — v1 translates ${SUPPORTED_TYPE} only. ` +
            `Refunds (charge.refunded) are REVERSAL ledger entries at the engine level, ` +
            'out of adapter scope.',
        );
      }

      const data = payload['data'];
      const obj =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)['object']
          : undefined;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        fail('webhook is missing data.object — cannot translate');
      }
      const pi = obj as Record<string, unknown>;

      const paymentIntentId = strField(pi, 'id');
      if (!paymentIntentId) fail('payment intent is missing id — cannot build an idempotency key');

      const amountReceived = pi['amount_received'];
      if (typeof amountReceived !== 'number' || !Number.isFinite(amountReceived)) {
        fail(
          `payment intent ${paymentIntentId} is missing a numeric amount_received ` +
            '(unsettled or malformed webhook)',
        );
      }
      if (!Number.isInteger(amountReceived) || amountReceived < 0) {
        fail(`payment intent ${paymentIntentId} has invalid amount_received ${amountReceived}`);
      }

      const currencyRaw = strField(pi, 'currency');
      if (!currencyRaw) fail(`payment intent ${paymentIntentId} is missing currency`);
      const currency = currencyRaw.toUpperCase();

      // Stripe smallest-unit → micros of the major unit (cents × 10_000 for USD).
      const amountMicros: Micros = Math.round(amountReceived * 10_000);

      // Round-half-up per the architecture notes (Math.round is half-up for positives).
      const processingCostMicros: Micros =
        Math.round((amountMicros * cost.rateBps) / 10_000) + cost.fixedMicros;

      const created = pi['created'];
      const occurredAt =
        typeof created === 'number' && Number.isFinite(created)
          ? new Date(created * 1000).toISOString()
          : new Date().toISOString();

      let attribution: AttributionClaim | undefined;
      const referrerId = strField(pi['metadata'], 'referrer_id');
      const campaignId = strField(pi['metadata'], 'campaign_id');
      if (referrerId || campaignId) {
        attribution = {};
        if (referrerId) attribution.referrerId = referrerId;
        if (campaignId) attribution.campaignId = campaignId;
      }
      const territory = strField(pi['metadata'], 'territory');

      const raw: Record<string, unknown> = { ...payload };
      if (currency !== 'USD') {
        // No warning, no conversion: pass through and note it.
        raw['_payloadFlow'] = {
          note:
            'non-USD currency passed through without conversion; ' +
            'the v1 Stripe adapter is USD-major and performs no FX (multi-currency netting is not yet modeled).',
        };
      }

      const rail: Rail = 'stripe';
      const event: EconomicEvent = {
        eventId: `stripe_${paymentIntentId}`,
        graphId,
        type: 'SALE_COMPLETED',
        occurredAt,
        amountMicros,
        currency,
        rail,
        processingCostMicros,
        raw,
      };
      if (attribution) event.attribution = attribution;
      if (territory) event.territory = territory;
      return [event];
    },
  };
}
