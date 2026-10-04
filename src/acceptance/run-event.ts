/**
 * Acceptance runner — feeds ONE real adapter input through the Rail and
 * prints the entitlement report.
 *
 *   node dist/acceptance/run-event.js --graph a|b|c --adapter stripe|x402|csv \
 *     --input <path-to-json-or-csv> [--dest participantId=address ...] \
 *     [--account acct-id] [--tier free|builder|pro|platform]
 *
 * - stripe: --input is a Stripe payment_intent.succeeded webhook JSON
 *   (object or JSON string). Signature verification happens in
 *   stripe-webhook-server.ts; this runner trusts the file it is given.
 * - x402: --input is an X402SettleConfirmation JSON (see src/adapters/x402.ts).
 * - csv: --input is a royalty-statement CSV (see src/adapters/csv.ts).
 *
 * Makes NO network calls and moves NO money. It computes entitlements and
 * prints proposed Distributions (status 'proposed') for the regulated
 * partner / facilitator to execute.
 */
import { readFileSync } from 'node:fs';
import { PayloadEvaluationEngine } from '../engine.js';
import { InMemoryEventStore } from '../event-store.js';
import { InMemoryStateStore } from '../state-store.js';
import { InMemoryLedger } from '../ledger.js';
import { createFeeEngine, InMemoryVolumeTracker } from '../fee-engine.js';
import { createStripeAdapter } from '../adapters/stripe.js';
import { createX402Adapter } from '../adapters/x402.js';
import { createCsvAdapter } from '../adapters/csv.js';
import {
  defineGraph,
  activateGraph,
  processEvent,
  formatSimulation,
} from '../sdk.js';
import type { EngineDeps, LicenseTier } from '../types.js';
import { GRAPH_BUILDERS, type GraphKey } from './graphs.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  console.error(`run-event: ${msg}`);
  process.exit(1);
}

const graphKey = arg('graph') as GraphKey | undefined;
const adapterKind = arg('adapter');
const inputPath = arg('input');
if (!graphKey || !(graphKey in GRAPH_BUILDERS)) fail('--graph must be a, b, or c');
if (!['stripe', 'x402', 'csv'].includes(adapterKind ?? '')) fail('--adapter must be stripe, x402, or csv');
if (!inputPath) fail('--input <path> is required');

const overrides: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dest' && argv[i + 1]) {
    const m = argv[i + 1]!.match(/^(.+?)=(.+)$/);
    if (m) overrides[m[1]!] = m[2]!;
    i++;
  }
}

const graph = activateGraph(defineGraph(GRAPH_BUILDERS[graphKey as GraphKey](overrides)));
const graphId = graph.id;

const volumeTracker = new InMemoryVolumeTracker();
const deps: EngineDeps = {
  eventStore: new InMemoryEventStore(),
  stateStore: new InMemoryStateStore(),
  ledger: new InMemoryLedger(),
  feeEngine: createFeeEngine(volumeTracker),
  accounting: {
    accountId: arg('account') ?? `acceptance-${graphKey}`,
    license: { accountId: arg('account') ?? `acceptance-${graphKey}`, tier: (arg('tier') as LicenseTier) ?? 'free', grantedAt: new Date().toISOString() },
  },
};
const engine = new PayloadEvaluationEngine(deps);

const x402Cfg: { graphId: string; assetCode: string; allowedAssets?: string[]; allowedNetworks?: string[] } = {
  graphId,
  assetCode: 'USDC',
};
const envAssets = process.env.X402_ALLOWED_ASSETS?.split(',').filter(Boolean);
if (envAssets?.length) x402Cfg.allowedAssets = envAssets;
const envNetworks = process.env.X402_ALLOWED_NETWORKS?.split(',').filter(Boolean);
if (envNetworks?.length) x402Cfg.allowedNetworks = envNetworks;

const adapter =
  adapterKind === 'stripe'
    ? createStripeAdapter({ graphId })
    : adapterKind === 'x402'
      ? createX402Adapter(x402Cfg)
      : createCsvAdapter({ graphId });

const rawInput = readFileSync(inputPath!, 'utf8');
const results = processEvent(engine, graph, deps, { adapter, raw: rawInput });

for (const res of results) {
  for (const line of formatSimulation(res, 'USD')) console.log(line);
  console.log('--- distributions (PROPOSED — partner executes, Rail never moves money) ---');
  for (const d of res.distributions) {
    console.log(
      `  ${d.participantId} -> ${d.destination.rail}:${d.destination.address} ` +
        `${(d.amountMicros / 1_000_000).toFixed(6)} ${d.currency} [${d.status}]`,
    );
  }
  if (res.skipped.length) {
    console.log('--- skipped rules ---');
    for (const s of res.skipped) console.log(`  ${s.ruleId}: ${s.reason}`);
  }
  if (res.idempotentReplay) console.log('NOTE: idempotent replay — no new ledger entries, no double-count.');
}

const ledger = deps.ledger as InMemoryLedger;
console.log(`--- ledger: ${ledger.entries().length} entries, chain valid: ${ledger.verifyChain()} ---`);
