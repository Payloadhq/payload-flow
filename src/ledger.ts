/**
 * ledger.ts — in-memory append-only hash-chained Ledger.
 *
 * Each appended entry receives: seq (1-based), at (ISO now — the one place
 * wall-clock time is allowed), prevHash (previous entry's hash, '' at genesis),
 * and hash = sha256(prevHash + canonicalJson(entry sans hash)). The canonical
 * JSON sorts object keys recursively so the hash is stable regardless of key
 * insertion order. verifyChain() recomputes every link and returns false at
 * the first broken one.
 *
 * entries() returns live references: treat them as read-only. Mutating a
 * returned entry is detectable — that is exactly what verifyChain() is for.
 */
import { createHash } from 'node:crypto';
import type { Ledger, LedgerEntry } from './types.js';

/** Canonical JSON: object keys sorted recursively; undefined dropped (JSON semantics). */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  throw new Error(`stableStringify: unsupported value of type '${t}'`);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export class InMemoryLedger implements Ledger {
  private readonly log: LedgerEntry[] = [];

  append(entry: Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'at'>): LedgerEntry {
    const prev = this.log.length > 0 ? this.log[this.log.length - 1] : undefined;
    const prevHash = prev ? prev.hash : '';
    const core = {
      seq: this.log.length + 1,
      at: new Date().toISOString(),
      prevHash,
      ...entry,
    };
    const hash = sha256Hex(prevHash + stableStringify(core));
    const full: LedgerEntry = { ...core, hash };
    this.log.push(full);
    return full;
  }

  entries(): LedgerEntry[] {
    return this.log;
  }

  entriesForEvent(eventId: string): LedgerEntry[] {
    return this.log.filter((e) => e.eventId === eventId);
  }

  entriesForGraph(graphId: string): LedgerEntry[] {
    return this.log.filter((e) => e.graphId === graphId);
  }

  verifyChain(): boolean {
    for (let i = 0; i < this.log.length; i++) {
      const entry = this.log[i];
      if (!entry) return false;
      const expectedPrev = i === 0 ? '' : this.log[i - 1]?.hash;
      if (entry.prevHash !== expectedPrev) return false;
      if (entry.seq !== i + 1) return false;
      const { hash, ...rest } = entry;
      void hash;
      const recomputed = sha256Hex(entry.prevHash + stableStringify(rest));
      if (recomputed !== entry.hash) return false;
    }
    return true;
  }
}
