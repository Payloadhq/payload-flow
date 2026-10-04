/**
 * Stripe webhook receiver for acceptance — verifies the Stripe signature and
 * feeds payment_intent.succeeded events through the Rail.
 *
 *   STRIPE_WEBHOOK_SECRET=whsec_... node dist/acceptance/stripe-webhook-server.js \
 *     --graph b --port 8787 [--dest participantId=address ...]
 *
 * POST /webhook with the raw Stripe body and the Stripe-Signature header.
 * Responds with the entitlement report as JSON. Signature verification is
 * HMAC-SHA256 over "<timestamp>.<raw body>" per Stripe's scheme, computed
 * with node:crypto — no stripe SDK dependency.
 *
 * Makes NO Stripe API calls and moves NO money. On success it prints proposed
 * Distributions for the partner to execute.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { PayloadEvaluationEngine } from '../engine.js';
import { InMemoryEventStore } from '../event-store.js';
import { InMemoryStateStore } from '../state-store.js';
import { InMemoryLedger } from '../ledger.js';
import { createFeeEngine, InMemoryVolumeTracker } from '../fee-engine.js';
import { createStripeAdapter } from '../adapters/stripe.js';
import { defineGraph, activateGraph, processEvent, formatSimulation } from '../sdk.js';
import type { EngineDeps } from '../types.js';
import { GRAPH_BUILDERS, type GraphKey } from './graphs.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  console.error(`stripe-webhook-server: ${msg}`);
  process.exit(1);
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) fail('STRIPE_WEBHOOK_SECRET env is required');
const graphKey = arg('graph') as GraphKey | undefined;
if (!graphKey || !(graphKey in GRAPH_BUILDERS)) fail('--graph must be a, b, or c');
const port = Number(arg('port') ?? 8787);

const overrides: Record<string, string> = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--dest=(.+?)=(.+)$/);
  if (m) overrides[m[1]!] = m[2]!;
}

const graph = activateGraph(defineGraph(GRAPH_BUILDERS[graphKey as GraphKey](overrides)));
const adapter = createStripeAdapter({ graphId: graph.id });
const volumeTracker = new InMemoryVolumeTracker();
const deps: EngineDeps = {
  eventStore: new InMemoryEventStore(),
  stateStore: new InMemoryStateStore(),
  ledger: new InMemoryLedger(),
  feeEngine: createFeeEngine(volumeTracker),
  accounting: {
    accountId: `acceptance-${graphKey}`,
    license: { accountId: `acceptance-${graphKey}`, tier: 'free', grantedAt: new Date().toISOString() },
  },
};
const engine = new PayloadEvaluationEngine(deps);

const TOLERANCE_S = 300;

function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET!).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (d: Buffer) => {
    body += d.toString('utf8');
  });
  req.on('end', () => {
    if (!verifySignature(body, req.headers['stripe-signature'] as string | undefined)) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: 'bad signature' }));
      return;
    }
    try {
      const results = processEvent(engine, graph, deps, { adapter, raw: body });
      const report = results.flatMap((r) => formatSimulation(r, 'USD'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, report }));
      for (const line of report) console.log(line);
    } catch (e) {
      res.writeHead(422).end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  });
}).listen(port, () => console.log(`stripe webhook receiver on :${port}/webhook (graph ${graph.id})`));
