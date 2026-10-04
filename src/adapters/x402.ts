/**
 * x402 adapter — translates facilitator settle confirmations into canonical
 * economic events.
 *
 * TRANSLATION ONLY: this module never evaluates rules, never moves money,
 * and never calls a live payment API or facilitator endpoint. It converts a
 * settle confirmation (the record that an on-chain settlement happened) into
 * the canonical {@link EconomicEvent} envelope and nothing more.
 *
 * Validation mirrors the x402 starter kit's layered guards (x402-core):
 *   1. Malformed-payload rejection — require txHash, amountMicros, asset,
 *      network, settledAt (cf. kit's 'malformed payment payload').
 *   2. Freshness — reject confirmations older than maxAgeMs with a 60s clock-
 *      skew tolerance (cf. kit's checkRequirementFreshness).
 *   3. Fail-closed allow-lists — when allowedAssets / allowedNetworks are
 *      configured, anything outside them is rejected (cf. the kit
 *      facilitator verifier's supports() guard).
 *   4. Replay dedupe — the eventId is `x402_{txHash}`, so redelivered
 *      confirmations collapse to the same idempotency key the engine dedupes
 *      on (cf. the kit's replay guard on txHash).
 *
 * Deliberately NOT copied from the kit: the HMAC dev verifier. This adapter
 * validates the *shape and freshness* of a confirmation; the trust boundary —
 * that a confirmation genuinely came from the facilitator — belongs to the
 * host integration, never to a shared-secret shortcut.
 */

import type {
  Adapter,
  AttributionClaim,
  EconomicEvent,
  Micros,
  Rail,
} from '../types.js';

/** Settle confirmation as produced by the x402 facilitator integration. */
export interface X402SettleConfirmation {
  /** On-chain transaction hash. The idempotency key. */
  txHash: string;
  /** CAIP-2 network identifier, e.g. 'eip155:8453'. */
  network: string;
  /** Settled asset: contract or mint address. */
  asset: string;
  /** Settled amount in integer 6-decimal base units (= micros of the asset unit). */
  amountMicros: number;
  /** Recipient address the settlement paid. */
  payTo: string;
  /** When settlement was confirmed (ISO 8601). */
  settledAt: string;
  paymentId?: string;
  usageUnits?: number;
  attribution?: { referrerId?: string; campaignId?: string };
  territory?: string;
}

export interface X402AdapterConfig {
  /** Graph the translated events belong to. */
  graphId: string;
  /** Currency code placed on the envelope, e.g. 'USDC'. */
  assetCode: string;
  /**
   * Default 0: facilitator gas is facilitator-side and is not deducted from
   * the routed value. Override when the host prices gas into the rail cost.
   */
  processingCostMicros?: Micros;
  /** Max confirmation age before rejection (default 5 min = 300_000 ms). */
  maxAgeMs?: number;
  /**
   * Fail-closed asset allow-list (contract/mint addresses). When omitted, any
   * non-empty asset string is accepted — mirroring the kit, where the
   * facilitator is authoritative and the local list is defense in depth.
   */
  allowedAssets?: string[];
  /** Fail-closed network allow-list (CAIP-2 strings). Same semantics. */
  allowedNetworks?: string[];
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
/** Clock-skew tolerance, mirroring the kit's REPLAY_SKEW_TOLERANCE_SEC. */
const SKEW_TOLERANCE_MS = 60 * 1000;

function fail(message: string): never {
  throw new Error(`x402 adapter: ${message}`);
}

function parseConfirmation(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    fail('input must be a settle confirmation object or a JSON string of one');
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  fail('input must be a settle confirmation object or a JSON string of one');
}

export function createX402Adapter(config: X402AdapterConfig): Adapter {
  const processingCostMicros: Micros = config.processingCostMicros ?? 0;
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const allowedAssets = config.allowedAssets ? new Set(config.allowedAssets) : undefined;
  const allowedNetworks = config.allowedNetworks ? new Set(config.allowedNetworks) : undefined;

  return {
    kind: 'x402',

    toEvents(input: unknown): EconomicEvent[] {
      const c = parseConfirmation(input);

      // 1. Required fields — fail closed on anything malformed.
      const txHash = c['txHash'];
      if (typeof txHash !== 'string' || txHash.length === 0) {
        fail('malformed settle confirmation: txHash is required');
      }
      const network = c['network'];
      if (typeof network !== 'string' || network.length === 0) {
        fail('malformed settle confirmation: network (CAIP-2) is required');
      }
      const asset = c['asset'];
      if (typeof asset !== 'string' || asset.length === 0) {
        fail('malformed settle confirmation: asset (contract/mint) is required');
      }
      const amountMicros = c['amountMicros'];
      if (typeof amountMicros !== 'number' || !Number.isInteger(amountMicros) || amountMicros <= 0) {
        fail('malformed settle confirmation: amountMicros must be a positive integer');
      }
      const settledAt = c['settledAt'];
      if (typeof settledAt !== 'string' || settledAt.length === 0) {
        fail('malformed settle confirmation: settledAt (ISO 8601) is required');
      }

      // 2. Fail-closed allow-lists when configured.
      if (allowedAssets && !allowedAssets.has(asset)) {
        fail(`asset ${asset} is not in this adapter's supported assets [${[...allowedAssets].join(', ')}]`);
      }
      if (allowedNetworks && !allowedNetworks.has(network)) {
        fail(
          `network ${network} is not in this adapter's supported networks [${[...allowedNetworks].join(', ')}]`,
        );
      }

      // 3. Freshness — reject expired (or future-dated) confirmations.
      const settledMs = Date.parse(settledAt);
      if (!Number.isFinite(settledMs)) {
        fail('malformed settle confirmation: settledAt is not a parseable ISO 8601 timestamp');
      }
      const nowMs = Date.now();
      const ageMs = nowMs - settledMs;
      if (ageMs > maxAgeMs + SKEW_TOLERANCE_MS) {
        fail(
          `expired settle confirmation: settled ${Math.round(ageMs / 1000)}s ago ` +
            `(max ${Math.round(maxAgeMs / 1000)}s + ${SKEW_TOLERANCE_MS / 1000}s skew tolerance)`,
        );
      }
      if (ageMs < -SKEW_TOLERANCE_MS) {
        fail('malformed settle confirmation: settledAt is in the future beyond clock-skew tolerance');
      }

      // 4. Optional usage units.
      let usageUnits: number | undefined;
      const rawUnits = c['usageUnits'];
      if (rawUnits !== undefined) {
        if (typeof rawUnits !== 'number' || !Number.isFinite(rawUnits) || rawUnits < 0) {
          fail('malformed settle confirmation: usageUnits must be a finite non-negative number');
        }
        usageUnits = rawUnits;
      }

      let attribution: AttributionClaim | undefined;
      const rawAttr = c['attribution'];
      if (rawAttr && typeof rawAttr === 'object' && !Array.isArray(rawAttr)) {
        const a = rawAttr as Record<string, unknown>;
        const referrerId = typeof a['referrerId'] === 'string' ? a['referrerId'] : undefined;
        const campaignId = typeof a['campaignId'] === 'string' ? a['campaignId'] : undefined;
        if (referrerId || campaignId) {
          attribution = {};
          if (referrerId) attribution.referrerId = referrerId;
          if (campaignId) attribution.campaignId = campaignId;
        }
      }
      const territory = typeof c['territory'] === 'string' ? (c['territory'] as string) : undefined;

      const rail: Rail = 'x402';
      const event: EconomicEvent = {
        // Redelivered confirmations produce the same eventId; the engine
        // dedupes on it (idempotent replay, no double-count).
        eventId: `x402_${txHash}`,
        graphId: config.graphId,
        type: 'API_PAYMENT',
        occurredAt: new Date(settledMs).toISOString(),
        amountMicros,
        currency: config.assetCode,
        rail,
        processingCostMicros,
        raw: { ...c },
      };
      if (usageUnits !== undefined) event.usageUnits = usageUnits;
      if (attribution) event.attribution = attribution;
      if (territory) event.territory = territory;
      return [event];
    },
  };
}
