/**
 * Fee engine v2 — exact-math tests.
 *
 * All expectations are computed by hand in the test from the formula:
 *   fee = max(rail_floor, round_half_up(effective_bps x charged_net / 10000))
 *   net = max(0, amount - processing_cost)
 *   tier rate on trailing-30d net BEFORE the event:
 *     <= $10k -> 100 bps | <= $100k -> 60 | <= $1M -> 35 | > $1M -> 20
 *   license multipliers: free 1.0, builder 0.8, pro 0.6, platform 0.45,
 *     enterprise -> negotiated (throws when missing)
 *   free tier: first $1,000,000,000 micros ($1,000) lifetime net at 0%.
 */

import { describe, expect, it } from 'vitest';
import type { License, LicenseTier, Rail } from '../src/types.js';
import { createFeeEngine, InMemoryVolumeTracker } from '../src/fee-engine.js';

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';

function license(tier: LicenseTier, enterpriseRateMultiplier?: number): License {
  return { accountId: 'test', tier, enterpriseRateMultiplier, grantedAt: T0 };
}

describe('fee engine v2', () => {
  describe('(a) microtransaction sweep, free allowance exhausted', () => {
    // $1,000 lifetime recorded up front: free allowance exhausted, and
    // trailing-30d = $1,000 -> 100 bps tier, multiplier 1.0 -> 100 bps.
    const tickets = [
      10_000, // $0.01
      100_000, // $0.10
      1_000_000, // $1
      2_000_000, // $2
      10_000_000, // $10
      100_000_000, // $100
      1_000_000_000, // $1,000
      10_000_000_000, // $10,000
    ];

    const cases: Array<{ rail: Rail; cost: number; fees: number[] }> = [
      {
        // x402 Solana-class rail cost $0.003; floor $0 never binds.
        rail: 'x402',
        cost: 3_000,
        fees: [70, 970, 9_970, 19_970, 99_970, 999_970, 9_999_970, 99_999_970],
      },
      {
        // stripe floor $0.01 binds on the two tiny tickets, ties on $1.
        rail: 'stripe',
        cost: 0,
        fees: [
          10_000, 10_000, 10_000, 20_000, 100_000, 1_000_000, 10_000_000,
          100_000_000,
        ],
      },
      {
        // ach: floor $0, fee is pure 1% of net.
        rail: 'ach',
        cost: 0,
        fees: [100, 1_000, 10_000, 20_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
      },
      {
        // manual: identical to ach (floor $0).
        rail: 'manual',
        cost: 0,
        fees: [100, 1_000, 10_000, 20_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
      },
    ];

    for (const { rail, cost, fees } of cases) {
      it(`sweep on rail ${rail}`, () => {
        const tracker = new InMemoryVolumeTracker();
        const engine = createFeeEngine(tracker);
        engine.recordVolume('sweep', T0, 1_000_000_000); // exhaust free allowance

        tickets.forEach((amount, i) => {
          const r = engine.computeFee({
            amountMicros: amount,
            processingCostMicros: cost,
            rail,
            accountId: 'sweep',
            license: license('free'),
            at: T1,
          });
          expect(r.feeMicros).toBe(fees[i]);
          expect(r.rateBps).toBe(100);
          expect(r.netMicros).toBe(Math.max(0, amount - cost));
          expect(r.tier).toBe('free');
        });
      });
    }
  });

  describe('(b) free tier allowance', () => {
    it('first $1,000 lifetime net is assessed at 0%', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      const r = engine.computeFee({
        amountMicros: 1_000_000_000, // $1,000
        processingCostMicros: 0,
        rail: 'x402',
        accountId: 'free-new',
        license: license('free'),
        at: T1,
      });
      expect(r.netMicros).toBe(1_000_000_000);
      expect(r.feeMicros).toBe(0);
      expect(r.rateBps).toBe(100); // rate still resolves; nothing is charged
    });

    it('intra-event partial allowance: fee applies only to the charged portion', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      engine.recordVolume('free-partial', T0, 900_000_000); // $900 used
      // $200 net event: $100 covered by remaining allowance, $100 charged.
      const r = engine.computeFee({
        amountMicros: 200_000_000,
        processingCostMicros: 0,
        rail: 'x402',
        accountId: 'free-partial',
        license: license('free'),
        at: T1,
      });
      // chargedNet = max(0, 900M + 200M - 1000M) = 100M; fee = 1% x 100M = 1M.
      expect(r.feeMicros).toBe(1_000_000);
    });
  });

  describe('(c) volume-tier transitions', () => {
    it('crossing $10k / $100k / $1M trailing-30d changes the effective rate', () => {
      const tracker = new InMemoryVolumeTracker();
      const engine = createFeeEngine(tracker);
      const args = {
        amountMicros: 1_000_000, // $1
        processingCostMicros: 0,
        rail: 'manual' as Rail,
        accountId: 'tiers',
        license: license('builder'), // x0.8
        at: T1,
      };

      expect(engine.computeFee(args)).toMatchObject({ rateBps: 80, feeMicros: 8_000 });

      engine.recordVolume('tiers', T0, 10_000_000_000); // exactly $10k: still 100 bps
      expect(engine.computeFee(args)).toMatchObject({ rateBps: 80, feeMicros: 8_000 });

      engine.recordVolume('tiers', T0, 1); // $10,000.000001 -> 60 bps
      expect(engine.computeFee(args)).toMatchObject({ rateBps: 48, feeMicros: 4_800 });

      engine.recordVolume('tiers', T0, 90_000_000_000); // $100,000.000001 -> 35 bps
      expect(engine.computeFee(args)).toMatchObject({ rateBps: 28, feeMicros: 2_800 });

      engine.recordVolume('tiers', T0, 900_000_000_000); // $1,000,000.000001 -> 20 bps
      expect(engine.computeFee(args)).toMatchObject({ rateBps: 16, feeMicros: 1_600 });
    });
  });

  describe('(d) license multipliers', () => {
    const args = (tier: LicenseTier, mult?: number) => ({
      amountMicros: 1_000_000,
      processingCostMicros: 0,
      rail: 'manual' as Rail,
      accountId: 'lic',
      license: license(tier, mult),
      at: T1,
    });

    it('builder x0.8, pro x0.6, platform x0.45', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      expect(engine.computeFee(args('builder'))).toMatchObject({ rateBps: 80, feeMicros: 8_000 });
      expect(engine.computeFee(args('pro'))).toMatchObject({ rateBps: 60, feeMicros: 6_000 });
      expect(engine.computeFee(args('platform'))).toMatchObject({ rateBps: 45, feeMicros: 4_500 });
    });

    it('enterprise uses the negotiated multiplier (fractional rate allowed)', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      const r = engine.computeFee(args('enterprise', 0.5));
      expect(r.rateBps).toBe(50);
      expect(r.feeMicros).toBe(5_000);
      expect(r.tier).toBe('enterprise');
    });

    it('platform on the 35 bps tier yields a fractional effective rate', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      engine.recordVolume('lic-frac', T0, 100_000_000_001); // > $100k -> 35 bps
      const r = engine.computeFee({ ...args('platform'), accountId: 'lic-frac' });
      // 35 x 0.45 = 15.75 bps; fee = round_half_up(15.75 x 1M / 10000) = 1575.
      expect(r.rateBps).toBe(15.75);
      expect(r.feeMicros).toBe(1_575);
    });

    it('enterprise without a multiplier throws', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      expect(() => engine.computeFee(args('enterprise'))).toThrow(
        /enterpriseRateMultiplier/,
      );
    });
  });

  describe('(e) counsel-gated rail', () => {
    it('stablecoin rail throws', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      expect(() =>
        engine.computeFee({
          amountMicros: 1_000_000,
          processingCostMicros: 0,
          rail: 'stablecoin',
          accountId: 'x',
          license: license('free'),
          at: T1,
        }),
      ).toThrow(/counsel-gated/);
    });
  });

  describe('(f) net floors at zero', () => {
    it('processing cost above amount yields net 0 and fee 0', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      const r = engine.computeFee({
        amountMicros: 10_000, // $0.01
        processingCostMicros: 50_000, // $0.05
        rail: 'manual',
        accountId: 'neg',
        license: license('free'),
        at: T1,
      });
      expect(r.netMicros).toBe(0);
      expect(r.feeMicros).toBe(0);
    });

    it('zero-amount event yields zero fee', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      const r = engine.computeFee({
        amountMicros: 0,
        processingCostMicros: 0,
        rail: 'x402',
        accountId: 'zero',
        license: license('pro'),
        at: T1,
      });
      expect(r.netMicros).toBe(0);
      expect(r.feeMicros).toBe(0);
    });
  });

  describe('(g) volume tracker windows', () => {
    it('trailing-30d sums records in (at-30d, at]; lifetime sums everything', () => {
      const tracker = new InMemoryVolumeTracker();
      tracker.record('win', '2026-09-01T00:00:00.000Z', 5_000_000_000);
      tracker.record('win', '2026-09-16T00:00:00.000Z', 3_000_000_000);

      expect(tracker.trailing30dNetMicros('win', '2026-09-21T00:00:00.000Z')).toBe(
        8_000_000_000,
      );
      // First record has aged out of the window; only the Sept 16 record counts.
      expect(tracker.trailing30dNetMicros('win', '2026-10-02T00:00:00.000Z')).toBe(
        3_000_000_000,
      );
      expect(tracker.lifetimeNetMicros('win')).toBe(8_000_000_000);
    });

    it('window is open on the left, closed on the right', () => {
      const tracker = new InMemoryVolumeTracker();
      // Exactly at (at - 30d): excluded.
      tracker.record('edge', '2026-08-22T00:00:00.000Z', 7_000_000_000);
      expect(tracker.trailing30dNetMicros('edge', '2026-09-21T00:00:00.000Z')).toBe(0);
      // Exactly at `at`: included.
      tracker.record('edge', '2026-09-21T00:00:00.000Z', 4_000_000_000);
      expect(tracker.trailing30dNetMicros('edge', '2026-09-21T00:00:00.000Z')).toBe(
        4_000_000_000,
      );
    });

    it('recordVolume changes the tier used by later fee computations', () => {
      const engine = createFeeEngine(new InMemoryVolumeTracker());
      const args = {
        amountMicros: 1_000_000,
        processingCostMicros: 0,
        rail: 'manual' as Rail,
        accountId: 'win-fee',
        license: license('builder'),
        at: T1,
      };
      expect(engine.computeFee(args).feeMicros).toBe(8_000); // 100 bps x 0.8
      engine.recordVolume('win-fee', T0, 100_000_000_001); // > $100k -> 35 bps
      const r = engine.computeFee(args);
      expect(r.rateBps).toBe(28);
      expect(r.feeMicros).toBe(2_800);
    });
  });
});
