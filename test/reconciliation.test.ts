/**
 * Reconciliation tests — instructions vs partner settlement reports.
 */

import { describe, expect, it } from 'vitest';
import type { Distribution, SettlementReportLine } from '../src/types.js';
import { createReconciler } from '../src/reconciliation.js';

function distribution(instructionId: string, amountMicros: number): Distribution {
  return {
    instructionId,
    graphId: 'g1',
    eventId: 'e1',
    participantId: 'p1',
    destination: { rail: 'ach', address: 'acct-123' },
    amountMicros,
    currency: 'USD',
    rail: 'ach',
    status: 'proposed',
  };
}

function line(
  instructionId: string,
  status: 'settled' | 'failed',
  settledAmountMicros?: number,
): SettlementReportLine {
  return { instructionId, status, settledAmountMicros, at: '2026-10-03T12:00:00.000Z' };
}

describe('reconciler', () => {
  it('all-settled matching report -> zero exceptions', () => {
    const r = createReconciler();
    const dists = [distribution('i1', 1_000_000), distribution('i2', 2_000_000)];
    const report = [line('i1', 'settled', 1_000_000), line('i2', 'settled', 2_000_000)];
    expect(r.reconcile(dists, report)).toEqual([]);
    expect(r.exceptions()).toEqual([]);
  });

  it('amount mismatch -> one amount_mismatch carrying both amounts', () => {
    const r = createReconciler();
    const queued = r.reconcile([distribution('i1', 1_000_000)], [
      line('i1', 'settled', 999_000),
    ]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      instructionId: 'i1',
      kind: 'amount_mismatch',
    });
    expect(queued[0]!.detail).toContain('999000');
    expect(queued[0]!.detail).toContain('1000000');
    expect(r.exceptions()).toHaveLength(1);
  });

  it('missing report line -> missing_settlement', () => {
    const r = createReconciler();
    const queued = r.reconcile([distribution('i1', 1_000_000)], []);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ instructionId: 'i1', kind: 'missing_settlement' });
  });

  it('failed report line -> missing_settlement with failure detail', () => {
    const r = createReconciler();
    const queued = r.reconcile([distribution('i1', 1_000_000)], [
      line('i1', 'failed'),
    ]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ instructionId: 'i1', kind: 'missing_settlement' });
    expect(queued[0]!.detail).toMatch(/failure/);
  });

  it('report line for an unknown instruction -> unexpected_settlement', () => {
    const r = createReconciler();
    const queued = r.reconcile([distribution('i1', 1_000_000)], [
      line('i1', 'settled', 1_000_000),
      line('ghost-1', 'settled', 5_000),
    ]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      instructionId: 'ghost-1',
      kind: 'unexpected_settlement',
    });
  });

  it('repeat reconcile -> no duplicate exceptions', () => {
    const r = createReconciler();
    const dists = [distribution('i1', 1_000_000)];
    const report = [line('i1', 'settled', 999_000)];
    const first = r.reconcile(dists, report);
    expect(first).toHaveLength(1);
    const second = r.reconcile(dists, report);
    expect(second).toEqual([]);
    expect(r.exceptions()).toHaveLength(1);
  });

  it('new exceptions accumulate across runs', () => {
    const r = createReconciler();
    r.reconcile([distribution('i1', 1_000_000)], [line('i1', 'settled', 999_000)]);
    r.reconcile([distribution('i2', 2_000_000)], []);
    expect(r.exceptions()).toHaveLength(2);
    expect(r.exceptions().map((e) => e.instructionId)).toEqual(['i1', 'i2']);
  });
});
