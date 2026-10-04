/**
 * event-store.ts — in-memory first-class queryable event log.
 *
 * Adapters append; the engine queries. Attribution lookback (first/last-touch
 * determination over ingested touch events) depends on this being a real log,
 * not a fire-and-forget pipe. Appends validate their shape and reject
 * duplicate eventIds — the eventId is the idempotency key, so a second append
 * of the same id is a hard error, never a silent overwrite.
 */
import { validateEvent, validateTouchEvent } from './events.js';
import type { EconomicEvent, EventStore, EventType, TouchEvent } from './types.js';

type Stored =
  | { kind: 'economic'; event: EconomicEvent }
  | { kind: 'touch'; event: TouchEvent };

function toMs(iso: string): number {
  return Date.parse(iso);
}

export class InMemoryEventStore implements EventStore {
  private readonly byId = new Map<string, Stored>();

  append(event: EconomicEvent | TouchEvent): void {
    // Discriminate on the presence of `type`: only EconomicEvents carry it.
    if (isRecordWithType(event)) {
      const valid = validateEvent(event);
      this.insert(valid.eventId, { kind: 'economic', event: valid });
    } else {
      const valid = validateTouchEvent(event);
      this.insert(valid.eventId, { kind: 'touch', event: valid });
    }
  }

  appendTouch(touch: TouchEvent): void {
    const valid = validateTouchEvent(touch);
    this.insert(valid.eventId, { kind: 'touch', event: valid });
  }

  private insert(eventId: string, stored: Stored): void {
    if (this.byId.has(eventId)) {
      throw new Error(`duplicate eventId '${eventId}': the event store rejects re-ingest; redelivery is handled by engine idempotency`);
    }
    this.byId.set(eventId, stored);
  }

  getEvent(eventId: string): (EconomicEvent | TouchEvent) | undefined {
    return this.byId.get(eventId)?.event;
  }

  queryTouches(filter: {
    graphId: string;
    referrerId?: string;
    campaignId?: string;
    from?: string;
    to?: string;
  }): TouchEvent[] {
    const fromMs = filter.from !== undefined ? toMs(filter.from) : undefined;
    const toMs_ = filter.to !== undefined ? toMs(filter.to) : undefined;
    const out: TouchEvent[] = [];
    for (const stored of this.byId.values()) {
      if (stored.kind !== 'touch') continue;
      const t = stored.event;
      if (t.graphId !== filter.graphId) continue;
      if (filter.referrerId !== undefined && t.referrerId !== filter.referrerId) continue;
      if (filter.campaignId !== undefined && t.campaignId !== filter.campaignId) continue;
      const at = toMs(t.occurredAt);
      if (fromMs !== undefined && at < fromMs) continue;
      if (toMs_ !== undefined && at > toMs_) continue;
      out.push(t);
    }
    // Deterministic order: earliest first, ties broken by eventId.
    out.sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt) || (a.eventId < b.eventId ? -1 : 1));
    return out;
  }

  queryEvents(filter: { graphId: string; type?: EventType; from?: string; to?: string }): EconomicEvent[] {
    const fromMs = filter.from !== undefined ? toMs(filter.from) : undefined;
    const toMs_ = filter.to !== undefined ? toMs(filter.to) : undefined;
    const out: EconomicEvent[] = [];
    for (const stored of this.byId.values()) {
      if (stored.kind !== 'economic') continue;
      const e = stored.event;
      if (e.graphId !== filter.graphId) continue;
      if (filter.type !== undefined && e.type !== filter.type) continue;
      const at = toMs(e.occurredAt);
      if (fromMs !== undefined && at < fromMs) continue;
      if (toMs_ !== undefined && at > toMs_) continue;
      out.push(e);
    }
    out.sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt) || (a.eventId < b.eventId ? -1 : 1));
    return out;
  }

  /** Test/debug helper. */
  size(): number {
    return this.byId.size;
  }
}

function isRecordWithType(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)['type'] === 'string'
  );
}
