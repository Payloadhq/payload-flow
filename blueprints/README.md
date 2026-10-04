# Revenue Blueprints

Copy-paste Revenue Graph specs for common economic patterns. Each blueprint is a
ready-to-use `POST /v1/graphs` body (replace `YOUR_PROJECT_ID` and the `acct_*`
placeholders with real values), validated against the Flow engine with exact
pool conservation.

The royalty belongs to the Revenue Graph, not the payment rail: these graphs
work identically whether the economic event arrives via Stripe, x402, or CSV.

## The blueprints

### 1. API revenue share (`api-revenue-share.json`)
For anyone monetizing an API, tool, or digital product with contributors.
- 10% referral (resolved from `event.attribution.referrerId`; skipped cleanly when absent)
- 20% contributor
- Remainder to operator
- Mirrors the split proven in the live x402 acceptance (0.10 USDC settlements on Base Sepolia).

### 2. Marketplace split (`marketplace-split.json`)
For multi-seller marketplaces and platforms.
- 5% affiliate referral
- 10% platform fee (first-class `platform_fee` rule, separate from the Payload infrastructure fee)
- Remainder to seller

### 3. Creator recoupment (`creator-recoupment.json`)
For labels, publishers, and anyone advancing money against future revenue.
- 100% of the artist's share works down a $10,000 advance until recouped (stateful across events and restarts)
- After recoupment, the artist keeps 50% of their share (`postRateBps`)
- Remainder to label
- The recoupment entitlement to the artist represents the advance being worked down; the label retains it until the advance is fully recouped, which the ledger shows per event.

## Using a blueprint

```bash
KEY=<your key>  # from POST https://payload-rail.fly.dev/v1/access-keys
BASE=https://payload-rail.fly.dev

# 1. Load (edit the JSON first: project id, participant ids, payout addresses)
curl -s -X POST $BASE/v1/graphs -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' --data @blueprints/api-revenue-share.json

# 2. Activate
curl -s -X POST $BASE/v1/graphs/bp_api_revenue_share/activate -H "Authorization: Bearer $KEY"

# 3. Preview before real money: simulate
curl -s -X POST $BASE/v1/graphs/bp_api_revenue_share/simulate -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{ "event": { ... } }'
```

Or run them in the browser with no key: https://payloadhq.github.io/flow-sandbox.html

## Economics

Blueprints are free. They run on the Rail's free tier. When your volume grows,
paid tiers keep the same graphs; nothing is rebuilt. Every distribution the
Rail computes is `status: "proposed"`; your Stripe Connect account or
facilitator executes payouts.
