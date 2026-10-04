/**
 * CSV adapter — translates royalty-statement CSVs into canonical economic
 * events.
 *
 * TRANSLATION ONLY: this module never evaluates rules, never moves money,
 * and performs no network I/O. It converts rows of a royalty statement into
 * `ROYALTY_RECEIVED` canonical events and nothing more.
 *
 * Header row (case-insensitive), required: event_id, occurred_at, amount, currency.
 * Optional: territory, source_ref, referrer_id, campaign_id.
 *
 * Amounts are decimal-major strings ("19.99") converted to micros EXACTLY —
 * the decimal string is parsed manually, never via float, so no rounding
 * error is possible. Fail-closed: malformed rows are collected and thrown as
 * ONE descriptive error listing row numbers; no partial ingestion occurs
 * (toEvents either returns all events or throws).
 */

import type { Adapter, AttributionClaim, EconomicEvent, Micros, Rail } from '../types.js';

export interface CsvAdapterConfig {
  /** Graph the translated events belong to. */
  graphId: string;
}

const REQUIRED_COLUMNS = ['event_id', 'occurred_at', 'amount', 'currency'] as const;

function fail(message: string): never {
  throw new Error(`csv adapter: ${message}`);
}

/** Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else if (c === '\r') {
      i += 1; // tolerate CRLF
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) fail('unterminated quoted field — input is not valid CSV');
  row.push(field);
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  // Drop blank lines (rows whose every field is empty).
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** Decimal-major string → micros, exactly. No float anywhere. */
function decimalToMicros(s: string): Micros {
  const t = s.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) {
    fail(`invalid amount "${s}" — expected a non-negative decimal with at most 6 fractional digits`);
  }
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(6, '0');
  return whole * 1_000_000 + Number(frac);
}

interface RowError {
  rowNumber: number;
  reason: string;
}

export function createCsvAdapter(config: CsvAdapterConfig): Adapter {
  return {
    kind: 'csv',

    toEvents(input: unknown): EconomicEvent[] {
      if (typeof input !== 'string') {
        fail('input must be a CSV string');
      }
      const rows = parseCsv(input);
      if (rows.length === 0) fail('empty CSV — no header row found');

      const header = rows[0]!.map((h) => h.trim().toLowerCase());
      const indexOf = new Map<string, number>();
      for (let i = 0; i < header.length; i++) {
        const name = header[i]!;
        if (indexOf.has(name)) fail(`duplicate column "${name}" in header row`);
        indexOf.set(name, i);
      }
      for (const required of REQUIRED_COLUMNS) {
        if (!indexOf.has(required)) {
          fail(`missing required column "${required}" (header: ${header.join(', ') || '(empty)'})`);
        }
      }
      const col = (row: string[], name: string): string => {
        const v = row[indexOf.get(name)!];
        return (v ?? '').trim();
      };
      const hasCol = (name: string): boolean => indexOf.has(name);

      const events: EconomicEvent[] = [];
      const errors: RowError[] = [];
      const seenIds = new Set<string>();

      for (let r = 1; r < rows.length; r++) {
        const rowNumber = r + 1; // 1-based, counting the header
        const row = rows[r]!;
        try {
          const eventIdRaw = col(row, 'event_id');
          if (!eventIdRaw) throw new Error('missing event_id');
          const eventId = `csv_${eventIdRaw}`;
          if (seenIds.has(eventId)) throw new Error(`duplicate event_id "${eventIdRaw}"`);
          seenIds.add(eventId);

          const occurredRaw = col(row, 'occurred_at');
          if (!occurredRaw) throw new Error('missing occurred_at');
          const occurredMs = Date.parse(occurredRaw);
          if (!Number.isFinite(occurredMs)) {
            throw new Error(`unparseable occurred_at "${occurredRaw}"`);
          }

          const amountRaw = col(row, 'amount');
          const amountMicros = decimalToMicros(amountRaw);

          const currencyRaw = col(row, 'currency');
          if (!currencyRaw) throw new Error('missing currency');

          const territoryRaw = hasCol('territory') ? col(row, 'territory') : '';
          const referrerRaw = hasCol('referrer_id') ? col(row, 'referrer_id') : '';
          const campaignRaw = hasCol('campaign_id') ? col(row, 'campaign_id') : '';

          let attribution: AttributionClaim | undefined;
          if (referrerRaw || campaignRaw) {
            attribution = {};
            if (referrerRaw) attribution.referrerId = referrerRaw;
            if (campaignRaw) attribution.campaignId = campaignRaw;
          }

          const raw: Record<string, unknown> = {};
          for (let i = 0; i < header.length; i++) {
            raw[header[i]!] = row[i] ?? '';
          }

          const rail: Rail = 'manual';
          const event: EconomicEvent = {
            eventId,
            graphId: config.graphId,
            type: 'ROYALTY_RECEIVED',
            occurredAt: new Date(occurredMs).toISOString(),
            amountMicros,
            currency: currencyRaw.toUpperCase(),
            rail,
            processingCostMicros: 0,
            raw,
          };
          if (attribution) event.attribution = attribution;
          if (territoryRaw) event.territory = territoryRaw;
          events.push(event);
        } catch (err) {
          errors.push({
            rowNumber,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (errors.length > 0) {
        const detail = errors.map((e) => `row ${e.rowNumber} (${e.reason})`).join('; ');
        fail(
          `rejected ${errors.length} malformed row(s); no events were ingested (fail-closed): ${detail}`,
        );
      }
      return events;
    },
  };
}
