import { describe, expect, it } from 'vitest';
import { createStripeAdapter } from '../src/adapters/stripe.js';
import { createX402Adapter } from '../src/adapters/x402.js';
import { createCsvAdapter } from '../src/adapters/csv.js';

const GRAPH = 'graph-1';

// ---------------------------------------------------------------- stripe ---
describe('stripe adapter', () => {
  const piSucceeded = {
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_123',
        amount_received: 10000, // $100.00 in cents
        currency: 'usd',
        created: 1728000000,
        metadata: { referrer_id: 'ref-1', campaign_id: 'camp-9', territory: 'US' },
      },
    },
  };

  it('happy path: exact micros, default fee, attribution, territory', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    const [event] = adapter.toEvents(piSucceeded);
    expect(adapter.kind).toBe('stripe');
    expect(event).toBeDefined();
    expect(event!.eventId).toBe('stripe_pi_123');
    expect(event!.graphId).toBe(GRAPH);
    expect(event!.type).toBe('SALE_COMPLETED');
    expect(event!.amountMicros).toBe(100_000_000); // $100.00 → 100_000_000 micros
    expect(event!.currency).toBe('USD');
    expect(event!.rail).toBe('stripe');
    // default cost: 290 bps of 100_000_000 = 2_900_000 + 300_000 fixed = 3_200_000
    expect(event!.processingCostMicros).toBe(3_200_000);
    expect(event!.attribution).toEqual({ referrerId: 'ref-1', campaignId: 'camp-9' });
    expect(event!.territory).toBe('US');
    expect(event!.raw).toMatchObject({ id: 'evt_1' });
    expect(event!.occurredAt).toBe(new Date(1728000000 * 1000).toISOString());
  });

  it('accepts a JSON string payload', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    const [event] = adapter.toEvents(JSON.stringify(piSucceeded));
    expect(event!.eventId).toBe('stripe_pi_123');
  });

  it('honors an overridden processing cost', () => {
    const adapter = createStripeAdapter({
      graphId: GRAPH,
      processingCost: { rateBps: 100, fixedMicros: 50_000 },
    });
    const [event] = adapter.toEvents(piSucceeded);
    expect(event!.processingCostMicros).toBe(1_000_000 + 50_000);
  });

  it('rounds the percentage fee half-up', () => {
    const adapter = createStripeAdapter({
      graphId: GRAPH,
      processingCost: { rateBps: 333, fixedMicros: 0 },
    });
    const [event] = adapter.toEvents({
      ...piSucceeded,
      data: { object: { ...piSucceeded.data.object, id: 'pi_2', amount_received: 1 } },
    });
    // 10_000 micros × 333/10_000 = 333 exactly
    expect(event!.processingCostMicros).toBe(333);
  });

  it('wrong event type throws (charge.refunded is engine-level, out of adapter scope)', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    expect(() =>
      adapter.toEvents({ ...piSucceeded, type: 'charge.refunded' }),
    ).toThrow(/unsupported webhook type "charge\.refunded"/);
  });

  it('missing amount_received throws', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    const broken = {
      ...piSucceeded,
      data: { object: { ...piSucceeded.data.object, amount_received: undefined } },
    };
    expect(() => adapter.toEvents(broken)).toThrow(/missing a numeric amount_received/);
  });

  it('non-USD passes through with a note in raw, no FX', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    const [event] = adapter.toEvents({
      ...piSucceeded,
      data: { object: { ...piSucceeded.data.object, id: 'pi_eur', currency: 'eur' } },
    });
    expect(event!.currency).toBe('EUR');
    expect(event!.amountMicros).toBe(100_000_000);
    expect(event!.raw['_payloadFlow']).toMatchObject({ note: expect.stringContaining('no FX') });
  });

  it('omits attribution when no metadata is present', () => {
    const adapter = createStripeAdapter({ graphId: GRAPH });
    const [event] = adapter.toEvents({
      ...piSucceeded,
      data: { object: { ...piSucceeded.data.object, id: 'pi_nomd', metadata: {} } },
    });
    expect(event!.attribution).toBeUndefined();
  });
});

// ------------------------------------------------------------------ x402 ---
describe('x402 adapter', () => {
  const confirmation = {
    txHash: '0xabc123',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4ED7E',
    amountMicros: 5_000_000,
    payTo: '0xmerchant',
    settledAt: new Date().toISOString(),
    usageUnits: 42,
    attribution: { referrerId: 'ref-x' },
  };

  it('happy path: canonical API_PAYMENT event', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const [event] = adapter.toEvents(confirmation);
    expect(adapter.kind).toBe('x402');
    expect(event!.eventId).toBe('x402_0xabc123');
    expect(event!.type).toBe('API_PAYMENT');
    expect(event!.amountMicros).toBe(5_000_000);
    expect(event!.currency).toBe('USDC');
    expect(event!.rail).toBe('x402');
    expect(event!.processingCostMicros).toBe(0); // facilitator gas is facilitator-side
    expect(event!.usageUnits).toBe(42);
    expect(event!.attribution).toEqual({ referrerId: 'ref-x' });
    expect(event!.raw).toMatchObject({ txHash: '0xabc123' });
  });

  it('missing txHash throws', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const { txHash: _drop, ...rest } = confirmation;
    expect(() => adapter.toEvents(rest)).toThrow(/malformed settle confirmation: txHash is required/);
  });

  it('missing network throws', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const { network: _drop, ...rest } = confirmation;
    expect(() => adapter.toEvents(rest)).toThrow(/network \(CAIP-2\) is required/);
  });

  it('missing asset throws', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const { asset: _drop, ...rest } = confirmation;
    expect(() => adapter.toEvents(rest)).toThrow(/asset \(contract\/mint\) is required/);
  });

  it('non-positive or non-integer amountMicros throws', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    expect(() => adapter.toEvents({ ...confirmation, amountMicros: 0 })).toThrow(
      /amountMicros must be a positive integer/,
    );
    expect(() => adapter.toEvents({ ...confirmation, amountMicros: 1.5 })).toThrow(
      /amountMicros must be a positive integer/,
    );
  });

  it('expired confirmation throws', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const old = { ...confirmation, settledAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    expect(() => adapter.toEvents(old)).toThrow(/expired settle confirmation/);
  });

  it('respects a custom maxAgeMs', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC', maxAgeMs: 60 * 60_000 });
    const old = { ...confirmation, settledAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    const [event] = adapter.toEvents(old); // 10 min < 60 min: accepted
    expect(event!.eventId).toBe('x402_0xabc123');
  });

  it('redelivered confirmation produces the same eventId (engine dedupes)', () => {
    const adapter = createX402Adapter({ graphId: GRAPH, assetCode: 'USDC' });
    const [a] = adapter.toEvents(confirmation);
    const [b] = adapter.toEvents({ ...confirmation }); // redelivery
    expect(a!.eventId).toBe(b!.eventId);
  });

  it('asset outside the allow-list throws fail-closed', () => {
    const adapter = createX402Adapter({
      graphId: GRAPH,
      assetCode: 'USDC',
      allowedAssets: ['0xother'],
    });
    expect(() => adapter.toEvents(confirmation)).toThrow(/not in this adapter's supported assets/);
  });

  it('honors an overridden processing cost', () => {
    const adapter = createX402Adapter({
      graphId: GRAPH,
      assetCode: 'USDC',
      processingCostMicros: 1_000,
    });
    const [event] = adapter.toEvents(confirmation);
    expect(event!.processingCostMicros).toBe(1_000);
  });
});

// ------------------------------------------------------------------- csv ---
describe('csv adapter', () => {
  const csv = [
    'event_id,occurred_at,amount,currency,territory,referrer_id,campaign_id',
    'row-1,2026-09-01T00:00:00Z,19.99,usd,US,ref-a,camp-1',
    'row-2,2026-09-02T00:00:00Z,5.5,EUR,,ref-b,',
  ].join('\n');

  it('happy path: exact micros from decimal-major strings', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    const events = adapter.toEvents(csv);
    expect(adapter.kind).toBe('csv');
    expect(events).toHaveLength(2);
    const [a, b] = events;
    expect(a!.eventId).toBe('csv_row-1');
    expect(a!.type).toBe('ROYALTY_RECEIVED');
    expect(a!.amountMicros).toBe(19_990_000); // "19.99" exactly — no float
    expect(a!.currency).toBe('USD');
    expect(a!.rail).toBe('manual');
    expect(a!.processingCostMicros).toBe(0);
    expect(a!.territory).toBe('US');
    expect(a!.attribution).toEqual({ referrerId: 'ref-a', campaignId: 'camp-1' });
    expect(a!.raw).toMatchObject({ event_id: 'row-1', amount: '19.99' });
    expect(b!.amountMicros).toBe(5_500_000); // "5.5" exactly
    expect(b!.attribution).toEqual({ referrerId: 'ref-b' });
  });

  it('handles CRLF and quoted fields', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    const events = adapter.toEvents(
      'event_id,occurred_at,amount,currency\r\n"row, 3",2026-09-03T00:00:00Z,0.000001,USD\r\n',
    );
    expect(events[0]!.eventId).toBe('csv_row, 3');
    expect(events[0]!.amountMicros).toBe(1); // smallest representable unit
  });

  it('malformed row: single descriptive error naming the row, no partial ingestion', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    const bad = [
      'event_id,occurred_at,amount,currency',
      'good-1,2026-09-01T00:00:00Z,10.00,USD',
      'bad-1,2026-09-02T00:00:00Z,not-a-number,USD',
      'bad-2,,10.00,USD',
    ].join('\n');
    let threw: Error | undefined;
    try {
      adapter.toEvents(bad);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).toBeDefined();
    expect(threw!.message).toMatch(/row 3/);
    expect(threw!.message).toMatch(/row 4/);
    expect(threw!.message).toMatch(/no events were ingested/);
    // fail-closed: the throw means nothing was returned at all
  });

  it('duplicate event_id is malformed', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    const dup = [
      'event_id,occurred_at,amount,currency',
      'dup-1,2026-09-01T00:00:00Z,10.00,USD',
      'dup-1,2026-09-02T00:00:00Z,11.00,USD',
    ].join('\n');
    expect(() => adapter.toEvents(dup)).toThrow(/row 3.*duplicate event_id/);
  });

  it('missing required column throws', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    expect(() => adapter.toEvents('event_id,occurred_at,currency\nx,2026-09-01,USD')).toThrow(
      /missing required column "amount"/,
    );
  });

  it('non-string input throws', () => {
    const adapter = createCsvAdapter({ graphId: GRAPH });
    expect(() => adapter.toEvents({} as unknown as string)).toThrow(/input must be a CSV string/);
  });
});
