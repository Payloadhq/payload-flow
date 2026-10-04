/**
 * Payload Flow MVP — pricing engine v2 (fee engine).
 *
 * Per economic event:
 *   fee = max(rail_floor[rail], rate(trailing30dNet, tier) x net)
 *   net = max(0, amount - processingCost), assessed only on successfully
 *   routed value.
 *
 * Money: integer micro-units throughout (USD 1.00 = 1_000_000). The single
 * rounding step is round-half-up at the final fee computation; everything
 * before it is exact integer math (BigInt for the fee numerator).
 *
 * Volume tiers are evaluated on trailing-30d NET BEFORE the current event.
 * computeFee is pure computation — it never records volume. The evaluation
 * engine records successfully routed (non-replay) volume via recordVolume.
 */

import type {
  FeeEngine,
  License,
  LicenseTier,
  Micros,
  Rail,
  VolumeTracker,
} from './types.js';

/** Trailing-volume window: (at - 30d, at]. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Free tier: first $1,000 of lifetime net volume is assessed at 0%. */
const FREE_ALLOWANCE_MICROS = 1_000_000_000;

/**
 * Volume tiers, evaluated top-down against trailing-30d net BEFORE the
 * current event. Bounds are inclusive: <= $10k -> 100 bps, etc.
 * (Source: DECISION_PACKAGE.md section 12.)
 */
const VOLUME_TIERS: ReadonlyArray<{ upToMicros: number; rateBps: number }> = [
  { upToMicros: 10_000_000_000, rateBps: 100 }, // <= $10,000
  { upToMicros: 100_000_000_000, rateBps: 60 }, // <= $100,000
  { upToMicros: 1_000_000_000_000, rateBps: 35 }, // <= $1,000,000
  { upToMicros: Number.POSITIVE_INFINITY, rateBps: 20 }, // > $1,000,000
];

/** One-time license multipliers on the volume-tier rate. */
const LICENSE_MULTIPLIERS: Record<Exclude<LicenseTier, 'enterprise'>, number> = {
  free: 1.0,
  builder: 0.8,
  pro: 0.6,
  platform: 0.45,
};

/** Rail floors, in micros. stripe floor = $0.01. */
const RAIL_FLOORS: Record<Exclude<Rail, 'stablecoin'>, Micros> = {
  x402: 0,
  manual: 0,
  stripe: 10_000,
  ach: 0,
};

/**
 * In-memory trailing-30-day net volume tracker, per account.
 * A record counts toward trailing30dNetMicros(accountId, at) when its
 * occurredAt lies in (at - 30d, at]: open on the left, closed on the right.
 */
export class InMemoryVolumeTracker implements VolumeTracker {
  private records = new Map<string, Array<{ atMs: number; netMicros: Micros }>>();

  record(accountId: string, at: string, netMicros: Micros): void {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new Error(`invalid ISO timestamp for volume record: ${at}`);
    }
    if (!Number.isInteger(netMicros) || netMicros < 0) {
      throw new Error(`netMicros must be a non-negative integer, got ${netMicros}`);
    }
    const list = this.records.get(accountId) ?? [];
    list.push({ atMs, netMicros });
    this.records.set(accountId, list);
  }

  trailing30dNetMicros(accountId: string, at: string): Micros {
    const atMs = Date.parse(at);
    const cutoffMs = atMs - THIRTY_DAYS_MS;
    let sum = 0;
    for (const r of this.records.get(accountId) ?? []) {
      if (r.atMs > cutoffMs && r.atMs <= atMs) {
        sum += r.netMicros;
      }
    }
    return sum;
  }

  lifetimeNetMicros(accountId: string): Micros {
    let sum = 0;
    for (const r of this.records.get(accountId) ?? []) {
      sum += r.netMicros;
    }
    return sum;
  }
}

function volumeTierRateBps(trailing30dNetMicros: Micros): number {
  for (const tier of VOLUME_TIERS) {
    if (trailing30dNetMicros <= tier.upToMicros) {
      return tier.rateBps;
    }
  }
  // Unreachable: the final tier is unbounded.
  return 20;
}

function licenseMultiplier(license: License): number {
  if (license.tier === 'enterprise') {
    if (license.enterpriseRateMultiplier === undefined) {
      throw new Error(
        'enterprise license requires enterpriseRateMultiplier to be set',
      );
    }
    return license.enterpriseRateMultiplier;
  }
  return LICENSE_MULTIPLIERS[license.tier];
}

/**
 * Round-half-up of (numerator / denominator) for non-negative integers,
 * computed exactly with BigInt so the single rounding step is exact.
 */
function roundHalfUp(numerator: bigint, denominator: bigint): number {
  return Number((numerator + denominator / 2n) / denominator);
}

export function createFeeEngine(tracker: VolumeTracker): FeeEngine {
  return {
    computeFee({ amountMicros, processingCostMicros, rail, accountId, license, at }) {
      if (rail === 'stablecoin') {
        throw new Error('stablecoin rail is counsel-gated: modeled, not executed');
      }

      // Net = successfully routed value; floors at 0 when rail cost exceeds amount.
      const netMicros = Math.max(0, amountMicros - processingCostMicros);

      // Volume tier is evaluated BEFORE this event (computeFee never records).
      const trailing = tracker.trailing30dNetMicros(accountId, at);
      const tierRateBps = volumeTierRateBps(trailing);

      // Effective rate, kept as integer hundredths of a basis point so the
      // final fee step stays exact (e.g. 35 bps x 0.45 = 1575 -> 15.75 bps).
      const effectiveBps100 = Math.round(tierRateBps * licenseMultiplier(license) * 100);

      // Free tier: the first $1,000 of lifetime net is assessed at 0%.
      // Only the portion of THIS event's net above the remaining allowance
      // is charged; capped at the event's net.
      let chargedNetMicros = netMicros;
      if (license.tier === 'free') {
        const lifetimeBefore = tracker.lifetimeNetMicros(accountId);
        chargedNetMicros = Math.min(
          netMicros,
          Math.max(0, lifetimeBefore + netMicros - FREE_ALLOWANCE_MICROS),
        );
      }

      const percentageFeeMicros = roundHalfUp(
        BigInt(effectiveBps100) * BigInt(chargedNetMicros),
        1_000_000n,
      );

      const feeMicros = Math.max(RAIL_FLOORS[rail], percentageFeeMicros);

      return {
        feeMicros,
        rateBps: effectiveBps100 / 100,
        netMicros,
        tier: license.tier,
      };
    },

    recordVolume(accountId: string, at: string, netMicros: Micros): void {
      tracker.record(accountId, at, netMicros);
    },
  };
}
