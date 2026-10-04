# Stripe rail acceptance — 2026-10-03 (LIVE)

Result: PASS (gates 1–3 fully; gate 4 partial, see notes).

- Mode: live (Stripe connection exposes live mode only; no test mode available).
- Payment: $1.00 USD via Checkout Session cs_live_a1LY23h3P8bU899hSu96FUC3Z8vah6zFlozG0QSzs6xIsgegZPQdJz1GXN
- PaymentIntent: pi_3UMaDyJoYZ92VVEn0HvRbnxO — succeeded
- Real event: evt_3UMaDyJoYZ92VVEn0SLCe3xY (payment_intent.succeeded), pulled from Stripe API
- Input file: acceptance/samples/stripe-live-1usd.json
- Graph: graph-b v1 (SaaS/marketplace), license tier builder

## Gate 1 — real payment on real rail: PASS
Live $1.00 charge on the Payload Stripe account. Session status paid/complete.

## Gate 2 — real adapter input reaches the Rail: PASS
The genuine Stripe event (not a fixture) was translated by the real
stripe adapter. The adapter picked up the actual Stripe processing cost
($0.329 = 2.9% + $0.30) from the event's balance transaction.

## Gate 3 — entitlements match engine math: PASS (micro-unit exact)
amount 1,000,000 | processing cost 329,000 | net pool 671,000
- payload_fee: 10,000 ($0.01) — rail floor bound (80bps × net = 5,368 < 10,000 floor)
- platform_fee: 39,660 (6% of 661,000)
- b-referral: SKIPPED, auditable reason (no attribution on event)
- developer: 31,067 (5% of 621,340)
- owner: 590,273 (remainder)
Conservation: 329,000 + 10,000 + 39,660 + 31,067 + 590,273 = 1,000,000. Exact.
Ledger: 7 entries, hash chain valid.

Distributions are status 'proposed' — the Rail executed nothing; the $1.00
(minus Stripe's $0.329 fee) sits in the Payload Stripe balance and pays out
to the linked bank on Stripe's normal schedule.

## Webhook trust boundary: PASS
stripe-webhook-server: valid HMAC signature → 200 + full entitlement report
on the real event body; forged signature → 401; missing signature → 401.

## Gate 4 — second transaction / replay: PASS (replay), live repeat deferred
Re-delivery of the same event returned idempotentReplay: true with no new
ledger entries (7 before and after). A second live $1 charge was not run;
repeat requires a fresh owner-approved transaction.

## Notes
- Stripe fee on $1.00 is 32.9% — expected at this size; micropayment economics
  are the rail's cost, not Payload's fee (Payload fee was the $0.01 floor).
- Test mode was unavailable via the OAuth connection (live context only).
  Future regression runs can reuse this event file without spending money.
