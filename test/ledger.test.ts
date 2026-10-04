/**
 * ledger.test.ts — hash-chained append-only ledger.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryLedger, stableStringify } from '../src/ledger.js';

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'e1',
    graphId: 'g1',
    graphVersion: 1,
    type: 'ENTITLEMENT' as const,
    ruleId: 'r1',
    participantId: 'alice',
    amountMicros: 1_000_000,
    reason: 'test',
    ...overrides,
  };
}

describe('InMemoryLedger', () => {
  it('assigns sequential seq numbers and links prevHash', () => {
    const ledger = new InMemoryLedger();
    const a = ledger.append(baseEntry({ eventId: 'e1' }));
    const b = ledger.append(baseEntry({ eventId: 'e2' }));
    const c = ledger.append(baseEntry({ eventId: 'e3' }));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
    expect(a.prevHash).toBe('');
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyChain() is true for an intact log', () => {
    const ledger = new InMemoryLedger();
    for (let i = 0; i < 5; i++) {
      ledger.append(baseEntry({ eventId: `e${i}`, amountMicros: i * 100 }));
    }
    expect(ledger.verifyChain()).toBe(true);
  });

  it('verifyChain() is false after tampering with an entry', () => {
    const ledger = new InMemoryLedger();
    ledger.append(baseEntry({ eventId: 'e1', amountMicros: 100 }));
    ledger.append(baseEntry({ eventId: 'e2', amountMicros: 200 }));
    ledger.append(baseEntry({ eventId: 'e3', amountMicros: 300 }));
    expect(ledger.verifyChain()).toBe(true);
    // Tamper with a middle entry's amount.
    ledger.entries()[1]!.amountMicros = 999_999;
    expect(ledger.verifyChain()).toBe(false);
  });

  it('verifyChain() is false after tampering with a hash link', () => {
    const ledger = new InMemoryLedger();
    ledger.append(baseEntry({ eventId: 'e1' }));
    ledger.append(baseEntry({ eventId: 'e2' }));
    ledger.entries()[1]!.prevHash = 'deadbeef';
    expect(ledger.verifyChain()).toBe(false);
  });

  it('entriesForEvent and entriesForGraph filter correctly', () => {
    const ledger = new InMemoryLedger();
    ledger.append(baseEntry({ eventId: 'e1', graphId: 'g1' }));
    ledger.append(baseEntry({ eventId: 'e1', graphId: 'g1', type: 'SKIPPED', ruleId: 'r2' }));
    ledger.append(baseEntry({ eventId: 'e2', graphId: 'g1' }));
    ledger.append(baseEntry({ eventId: 'e9', graphId: 'g2' }));
    expect(ledger.entriesForEvent('e1')).toHaveLength(2);
    expect(ledger.entriesForEvent('e2')).toHaveLength(1);
    expect(ledger.entriesForEvent('missing')).toHaveLength(0);
    expect(ledger.entriesForGraph('g1')).toHaveLength(3);
    expect(ledger.entriesForGraph('g2')).toHaveLength(1);
  });

  it('canonical JSON is stable regardless of key insertion order', () => {
    const a = stableStringify({ z: 1, a: { y: 2, b: 3 }, m: [3, 2, 1] });
    const b = stableStringify({ m: [3, 2, 1], a: { b: 3, y: 2 }, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"b":3,"y":2},"m":[3,2,1],"z":1}');
  });
});
