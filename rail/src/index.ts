/**
 * Payload Rail v1 — server factory and entrypoint.
 *
 * RAIL_DB_PATH env (default ./rail.db), PORT env (default 8787).
 * Every request is synchronous through better-sqlite3, so a response
 * implies durability: kill -9 after a 200 cannot lose committed data.
 */
import express from 'express';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { authMiddleware, rateLimitMiddleware, publicRateLimitMiddleware } from './auth.js';
import { requireEntitlement } from './entitlements.js';
import { requireQuota } from './metering.js';
import { buildRouter, buildPublicRouter } from './routes.js';
import { buildCryptoRouter, buildCryptoPublicRouter } from './crypto-routes.js';
import { buildPurchaseRouter } from './purchase-routes.js';
import { buildCreditRouter } from './credit-routes.js';
import { buildVeylineRouter } from './veyline-routes.js';
import { buildEnterpriseRouter, requireEnterpriseAdmin, orgRateLimitMiddleware } from './enterprise.js';
import { buildStripeRouter, createStripeWebhookHandler } from './stripe-routes.js';
import { buildOnboardingRouter } from './public-onboarding.js';
import { buildCallx402Router } from './callx402-actions.js';
import { loadCryptoConfig } from './crypto.js';
import openapiSpec from './openapi.json' with { type: 'json' };
import {
  analyticsMiddleware,
  getFunnelStats,
  getTopRoutes,
  initAnalyticsTables,
  trackFunnel,
} from './analytics.js';

/**
 * Public Observatory beacon receiver (additive, no auth).
 *
 * Privacy design: the request body may contain ONLY an allowlisted event name
 * and an allowlisted CTA name. Everything else is ignored. We store hourly
 * aggregate COUNTS only — no IP addresses, no user agents, no cookies, no
 * fingerprints, no identifiers of any kind. CORS is restricted to the
 * Observatory origin.
 */
const OBSERVATORY_ORIGIN = 'https://payloadhq.github.io';
const OBSERVATORY_EVENTS: Record<string, 'observatory_page_view' | 'observatory_search_used' | 'observatory_report_viewed' | 'observatory_cta_click' | 'observatory_checker_click' | 'observatory_github_action_click' | 'observatory_product_click' | 'observatory_checkout_click'> = {
  page_view: 'observatory_page_view',
  search_used: 'observatory_search_used',
  report_viewed: 'observatory_report_viewed',
  cta_click: 'observatory_cta_click',
  checker_click: 'observatory_checker_click',
  github_action_click: 'observatory_github_action_click',
  product_click: 'observatory_product_click',
  checkout_click: 'observatory_checkout_click',
};
const OBSERVATORY_CTAS = new Set([
  'manifest-check', 'monitor', 'tooling',
  'github-x402-manifest-check', 'github-mcp-readiness-check',
  'product-kit', 'checkout', 'portal', 'docs',
]);

function observatoryCors(res: express.Response): void {
  res.setHeader('Access-Control-Allow-Origin', OBSERVATORY_ORIGIN);
  res.setHeader('Vary', 'Origin');
}

function registerObservatoryBeacon(app: express.Express, db: Database.Database): void {
  app.options('/v1/events/observatory', (_req, res) => {
    observatoryCors(res);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });
  app.post('/v1/events/observatory', (req, res) => {
    observatoryCors(res);
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const funnelEvent = OBSERVATORY_EVENTS[String(body.event || '')];
      if (!funnelEvent) { res.status(204).end(); return; }
      // Only the event name and an allowlisted CTA name are accepted; the
      // rest of the body is ignored. Nothing identifying is ever stored.
      if (body.cta != null && !OBSERVATORY_CTAS.has(String(body.cta))) { res.status(204).end(); return; }
      trackFunnel(db, funnelEvent);
    } catch {
      /* analytics must never break requests */
    }
    res.status(204).end();
  });
}

export interface RailServer {
  app: express.Express;
  db: Database.Database;
  close(): void;
}

export function createServer(dbPath?: string): RailServer {
  const path = dbPath ?? process.env['RAIL_DB_PATH'] ?? './rail.db';
  const db = openDb(path);
  initAnalyticsTables(db);
  const app = express();
  app.disable('x-powered-by');
  // Stripe webhooks require the RAW request body for signature verification.
  // This must be registered BEFORE express.json(): body-parser marks the
  // request as parsed (req._body), so the later json() middleware skips it
  // and the webhook handler receives the intact Buffer.
  app.use('/v1/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  // Stripe webhook: mounted DIRECTLY (not via /v1 router) to bypass auth.
  // Stripe uses Stripe-Signature header, not Bearer tokens.
  app.post('/v1/stripe/webhook', createStripeWebhookHandler(db));
  app.use(express.json({ limit: '1mb' }));
  app.use(analyticsMiddleware(db));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Serve the RevRule Console (static Vite build) at /revrule-console/
  // This provides a zero-cost alternative to GitHub Pages.
  app.use('/revrule-console', express.static('console'));

  // Discovery document for x402 directories (x402scan, agent402, etc.)
  // Follows the x402scan discovery spec: info.x-guidance, x-payment-info with
  // fixed pricing, input/output schemas, and a 402 response declaration.
  // Served at /revrule-discovery.json so the canonical /openapi.json can
  // describe the full public API.
  app.get('/revrule-discovery.json', (_req, res) => {
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'RevRule by Payload',
        version: '1.0.0',
        description:
          'RevRule turns agreements and revenue into auditable economic entitlements. Upload the agreement. Connect the revenue. RevRule determines who is owed what. Your payment rail moves the money. RevRule determines the economics.',
        'x-guidance':
          "Use POST /v1/x402/event to submit a machine-commerce revenue event. Send JSON with graphId, amountUsd, source, and participants. Without payment it returns 402 with x402 payment requirements (0.01 USDC on Base); include the paid txHash and retry. The response contains per-participant entitlements and an auditable ledger entry.",
        contact: { email: 'kylers.partners@gmail.com' },
      },
      servers: [{ url: 'https://payload-rail.fly.dev' }],
      paths: {
        '/v1/x402/event': {
          post: {
            operationId: 'submitX402Event',
            summary: 'Submit a paid x402 economic event (API key required)',
            description:
              'Evaluates a machine-commerce revenue event against a Revenue Graph and returns per-participant entitlements with an auditable ledger entry. Requires API key authentication plus 0.01 USDC on Base per event via x402.',
            security: [{ ApiKeyAuth: [] }],
            'x-payment-info': {
              price: { mode: 'fixed', currency: 'USD', amount: '0.010000' },
              protocols: [{ x402: {} }],
            },
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      graphId: { type: 'string', description: 'Revenue Graph to evaluate against' },
                      amountUsd: { type: 'number', description: 'Gross event amount in USD' },
                      source: { type: 'string', description: 'Revenue source label, e.g. streaming, sync, api' },
                      participants: {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Optional participant overrides',
                      },
                      txHash: { type: 'string', description: 'Base USDC payment tx hash (after 402)' },
                    },
                    required: ['graphId', 'amountUsd'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Event evaluated; entitlements and ledger entry returned',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        entitlements: { type: 'array', items: { type: 'object' } },
                        ledgerEntry: { type: 'object' },
                      },
                    },
                  },
                },
              },
              '402': { description: 'Payment Required: 0.01 USDC on Base via x402' },
            },
          },
        },
        '/v1/x402/public/evaluate': {
          get: {
            operationId: 'publicX402EvaluateProbe',
            summary: 'Public x402 payment challenge probe (no auth required)',
            description:
              'Returns the x402 payment challenge (HTTP 402) for the public evaluation endpoint. Used by x402 discovery services to verify the paywall.',
            parameters: [
              {
                name: 'probe',
                in: 'query',
                required: false,
                description: 'Optional probe identifier for discovery services',
                schema: { type: 'string' },
              },
            ],
            responses: {
              '402': { description: 'Payment Required: 0.01 USDC on Base via x402' },
            },
          },
          post: {
            operationId: 'publicX402Evaluate',
            summary: 'Public x402 machine-commerce evaluation (no auth required)',
            description:
              'Public endpoint for machine discovery. Send an economic event without payment to receive a 402 challenge. Pay 0.01 USDC on Base, retry with txHash, and RevRule evaluates your event against the public demo graph, returning computed entitlements. No API key required.',
            'x-payment-info': {
              price: { mode: 'fixed', currency: 'USD', amount: '0.010000' },
              protocols: [{ x402: {} }],
            },
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      event: { type: 'object', description: 'Economic event to evaluate' },
                      txHash: { type: 'string', description: 'Base USDC payment tx hash (after 402)' },
                    },
                    required: ['event'],
                  },
                },
              },
            },
            responses: {
              '200': { description: 'Payment verified; entitlements returned' },
              '402': { description: 'Payment Required: 0.01 USDC on Base via x402' },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description: 'Bearer API key for authenticated endpoints',
          },
        },
      },
    });
  });

  // Machine-readable API description for agents (mirrors payloadhq.github.io/llms.txt scope)
  app.get('/llms.txt', (_req, res) => {
    res.type('text/plain').send(`# RevRule API — payload-rail.fly.dev

RevRule by Payload: a programmable revenue rules engine. Define a Revenue Graph,
send economic events, get auditable entitlements. Your payment rail moves the
money. RevRule determines the economics. RevRule never holds funds or moves money.

Base URL: https://payload-rail.fly.dev
OpenAPI: https://payload-rail.fly.dev/openapi.json
x402 manifest: https://payload-rail.fly.dev/.well-known/x402
Console: https://payload-rail.fly.dev/revrule-console/
Docs: https://payloadhq.github.io/revrule-api.html

## Quickstart (3 calls)
1. POST /v1/access-keys {"label":"..."} -> {"key":"...","accountId":"..."} (free, 5/IP/24h)
2. POST /v1/graphs (Bearer key) {id, participants[], rules[]} -> 201
3. POST /v1/graphs/{id}/events (Bearer key) {event:{eventId,graphId,amountMicros,currency,occurredAt}} -> entitlements[]

## Key endpoints
- GET /health -> {"ok":true}
- POST /v1/graphs/{id}/activate — activate a draft graph
- POST /v1/graphs/{id}/simulate — dry run, no side effects
- GET /v1/graphs/{id}/ledger — hash-chained ledger entries
- GET /v1/x402/public/evaluate — x402 v2 402 challenge: pay $0.01 USDC on Base, no API key
- POST /v1/x402/public/evaluate — {event, txHash} after paying
- GET /v1/crypto/config — machine-readable payment config (network, asset, prices)
- POST /v1/purchases/orders — create a wallet-bound purchase order (returns message_to_sign)
- POST /v1/purchases/redeem — redeem { order_id, tx_hash, signature } -> entitlement + API key
- POST /v1/crypto/purchase — DEPRECATED (bare txHash, front-runnable); use /v1/purchases/* instead

## Rules
Rule types: percentage, fixed, remainder, referral, recoupment, waterfall, caps.
Amounts in micro-units (1,000,000 = 1.00). Events idempotent on eventId.
Errors: {"error":{"code":"...","message":"..."}}.
`);
  });

  // Canonical OpenAPI specification for the full public Payload Rail API
  // (machine-readable contract). Serves the complete public operation set;
  // internal admin and operational endpoints are intentionally excluded.
  app.get('/openapi.json', (_req, res) => {
    res.json(openapiSpec);
  });

  // x402 well-known manifest for agent discovery
  app.get('/.well-known/x402', (_req, res) => {
    const cryptoConfig = loadCryptoConfig();
    res.json({
      name: 'RevRule by Payload',
      description:
        'Programmable revenue rules engine. Turns agreements and revenue into auditable economic entitlements.',
      baseUrl: 'https://payload-rail.fly.dev',
      payTo: cryptoConfig.enabled ? cryptoConfig.payTo : undefined,
      endpoints: [
        {
          path: '/v1/x402/public/evaluate',
          method: 'POST',
          price: '0.01',
          asset: 'USDC',
          network: 'base',
          auth: 'none',
          payTo: cryptoConfig.enabled ? cryptoConfig.payTo : undefined,
          description: 'Public x402 evaluation: pay $0.01 USDC, get RevRule entitlements. No API key.',
        },
        {
          path: '/v1/x402/event',
          method: 'POST',
          price: '0.01',
          asset: 'USDC',
          network: 'base',
          auth: 'api-key',
          payTo: cryptoConfig.enabled ? cryptoConfig.payTo : undefined,
          description: 'Authenticated x402 event against your own Revenue Graph.',
        },
      ],
    });
  });

  // Fly.io terminates TLS at the edge; trust one proxy hop so req.ip is the client.
  app.set('trust proxy', 1);

  // CORS for public onboarding endpoints (no auth): the Veyline homepage
  // calls these cross-origin (key issuance, Stripe checkout, success page).
  // Wildcard is safe here — these endpoints carry no credentials and the
  // responses contain only caller-specific data (their own key/session).
  const publicCors = (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  };
  app.use('/v1/access-keys', publicCors);
  app.use('/v1/stripe/checkout', publicCors);
  app.use('/v1/stripe/success', publicCors);
  app.use('/v1/stripe/keys', publicCors);
  app.use('/v1/contact', publicCors);
  app.use('/v1/veyline/sandbox-signup', publicCors);
  app.use('/v1/callx402/actions', publicCors);
  app.use('/v1/callx402/checkout', publicCors);
  app.use('/v1/callx402/success', publicCors);
  app.use('/v1/callx402/quote', publicCors);
  app.options('/v1/access-keys', (_req, res) => res.status(204).end());
  app.options('/v1/stripe/checkout', (_req, res) => res.status(204).end());
  app.options('/v1/stripe/success', (_req, res) => res.status(204).end());
  app.options('/v1/contact', (_req, res) => res.status(204).end());
  app.options('/v1/veyline/sandbox-signup', (_req, res) => res.status(204).end());

  // Public routes (no auth): self-serve key issuance with IP abuse control,
  // plus crypto settlement config and purchase. Public crypto endpoints get
  // IP-based rate limiting (2026-10-06: was unlimited, RPC-amplification DoS).
  app.use('/v1', buildPublicRouter(db));
  // NOTE (hardening 2026-10-06): buildCryptoPublicRouter applies
  // publicRateLimitMiddleware per-route internally. Do NOT add it at the
  // app.use('/v1') level here: that would count ALL /v1 traffic (including
  // authenticated API calls) against the public IP budget and 429 legitimate
  // users. See LAUNCH_HARDENING_2026-10-06.md.
  app.use('/v1', buildCryptoPublicRouter(db));
  // Secure purchase flow (public: new customers have no key yet).
  // Rate limiting is per-route inside buildPurchaseRouter (see note above).
  app.use('/v1', buildPurchaseRouter(db));
  // Migration credits: $79 starter-kit credit toward first Veyline order.
  // Claim is public (new customers have no key); balance needs a v2 API key.
  app.use('/v1', buildCreditRouter(db));
  // Stripe subscriptions: checkout (authenticated) + signed webhook.
  // The webhook path already has express.raw() applied above.
  app.use('/v1', buildStripeRouter(db));
  // Public onboarding: contact form + free-tier self-serve sandbox signup.
  // Rate limiting is per-route inside buildOnboardingRouter (see note above).
  app.use('/v1', buildOnboardingRouter(db));
  // callx402 on-demand per-action payments: public fee schedule, one-time
  // Stripe checkout, single-action credits, and the authorize/consume/meter
  // invocation endpoint. Rate limiting is per-route inside the router.
  // Mounted here (before the authenticated /v1 mounts) so /v1/callx402/*
  // stays public; the router enforces its own auth per route.
  app.use('/v1', buildCallx402Router(db));
  registerObservatoryBeacon(app, db);

  // Veyline product API (2026-10-07): the consumable surface for Veyline
  // product-bound credentials. Product isolation holds: veyline keys 403 on
  // revrule routes and vice versa. requireQuota records one billable
  // operation per request for tiered veyline credentials.
  //
  // ROUTING ORDER (fix 2026-10-07, worker CDE): this mount MUST come before
  // the generic '/v1' mounts below. Express evaluates app.use() in
  // registration order and '/v1' prefix-matches '/v1/veyline/*'; with the
  // old order the revrule requireEntitlement ran first and every veyline
  // credential 403'd with PRODUCT_MISMATCH, making the entire Veyline
  // product API unreachable. Specific paths mount before general ones.
  app.use('/v1/veyline', requireEntitlement(db, 'veyline'), requireQuota(db), orgRateLimitMiddleware(db), rateLimitMiddleware(), buildVeylineRouter(db));

  // Enterprise administration (2026-10-07): org admin controls for
  // Enterprise-tier orgs — key management, org usage, org policy, audit
  // export. Mounted before the generic '/v1' mounts below (same
  // prefix-matching reason as /v1/veyline). The admin gate requires an
  // active enterprise entitlement AND the veyline:admin key scope.
  app.use('/v1/enterprise',
    requireEntitlement(db, 'veyline'),
    requireEnterpriseAdmin(db),
    requireQuota(db),
    orgRateLimitMiddleware(db),
    rateLimitMiddleware(),
    buildEnterpriseRouter(db));

  // Authenticated routes: entitlement enforcement replaces bare key auth.
  // requireEntitlement resolves both v2 product-bound credentials and legacy
  // api_keys (legacy keys pass through unchanged, preserving live behavior).
  // requireQuota runs after requireEntitlement and is product-aware: it
  // enforces monthly operation quotas ONLY for v2 veyline-bound credentials
  // with a tiered opsPerMonth > 0, and no-ops for legacy credentials and
  // revrule traffic — so it automatically covers future veyline routes added
  // to these chains. All rail API routes are product 'revrule' (the RevRule
  // hosted API).
  app.use('/v1', requireEntitlement(db, 'revrule'), requireQuota(db), rateLimitMiddleware(), buildRouter(db));
  app.use('/v1', requireEntitlement(db, 'revrule'), requireQuota(db), rateLimitMiddleware(), buildCryptoRouter(db));

  // Internal usage reporting (API-key protected). Privacy-respecting:
  // hourly-bucketed counts only, no PII, no identifiers.
  app.get('/v1/internal/stats', authMiddleware(db), (req, res) => {
    const hours = Math.min(
      Math.max(parseInt(String(req.query['hours'] ?? '168'), 10) || 168, 1),
      720
    );
    res.json({
      funnel: getFunnelStats(db, hours),
      topRoutes: getTopRoutes(db, hours),
      windowHours: hours,
      generatedAt: new Date().toISOString(),
    });
  });

  // JSON 404 for unknown routes
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown route' } });
  });

  // Never leak stack traces or internals
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (res.headersSent) return;
      const message = err instanceof SyntaxError ? 'request body is not valid JSON' : 'request failed';
      res.status(400).json({ error: { code: 'INVALID_BODY', message } });
    },
  );

  return {
    app,
    db,
    close() {
      db.close();
    },
  };
}

// Direct execution: node dist/index.js
// isMain must ALSO check argv[1]: importing the built dist/index.js as a
// library (e.g. from a test harness) sets import.meta.url to '.../index.js'
// while argv[1] is the importer's path. Without the argv check, merely
// importing the module boots a server on :8787 (found 2026-10-07, worker CDE).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith('/index.js') &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/index.ts'));
if (isMain) {
  const port = Number(process.env['PORT'] ?? 8787);
  const { app, db } = createServer();
  const server = app.listen(port, () => {
    console.log(`payload rail v1 listening on :${port}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
