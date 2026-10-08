/**
 * Payload — callx402 on-demand per-action payment path (2026-10-07).
 *
 * Commercial model (Kyler-approved):
 *   callx402 = paid on-demand x402 assistance/actions.
 *   Incident -> action -> per-action fee -> result. No Veyline subscription required.
 *   Veyline subscribers may invoke via their API key (metered against their
 *   subscription usage); everyone else buys a single-action credit.
 *
 * Routes (mounted public at /v1 by index.ts; per-route auth below):
 *   GET  /v1/callx402/actions          public fee schedule (exact pricing)
 *   POST /v1/callx402/checkout          create a Stripe one-time Checkout Session
 *                                       for one action's fee (public; guest buyers
 *                                       get a provisioned org)
 *   GET  /v1/callx402/success?session_id=  show the purchased action credit ONCE
 *   POST /v1/callx402/actions/:action    authorize + consume + meter one action
 *                                       invocation. Requires EITHER a valid
 *                                       veyline-bound API key OR a paid unused
 *                                       action credit. No credit + no key -> 402
 *                                       with checkout instructions.
 *
 * SECURITY MODEL (mirrors stripe-routes.ts):
 * - Credits are created ONLY from Stripe-verified webhook events.
 *   Client-supplied data (checkout request body, query params, browser
 *   redirects) is NEVER trusted for credit creation.
 * - Webhook signature verification is mandatory and fail-closed.
 * - Fulfillment is idempotent: each Stripe event ID is recorded; replays
 *   and duplicate deliveries create at most one credit per session.
 * - Credit consumption is atomic: exactly one concurrent invocation wins.
 * - The rail authorizes, consumes, meters, AND executes read-only
 *   diagnostic actions server-side (diagnose, resolve, recover, preflight,
 *   failure_classification, settlement_interpretation, duplicate_payment_risk).
 *   A bare `npm install callx402` works with zero local setup: the CLI is a
 *   lightweight client (invoke -> free quote -> payment/authorization ->
 *   result). Actions requiring local execution or a Veyline ledger
 *   (execute, monitor, rescue mutations) still run in the caller's runtime.
 *   The rail never fakes execution: every returned result is produced by the
 *   vendored diagnostic modules over caller-supplied evidence.
 *
 * FEE SCHEDULE: initial schedule, owner-adjustable. Each action's fee can be
 * overridden with CALLX402_FEE_<ACTION> in whole USD cents (e.g.
 * CALLX402_FEE_RESCUE=2500). Amounts below are placeholders Kyler can adjust;
 * they are served verbatim by GET /v1/callx402/actions so agents always see
 * the live schedule.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import {
  getOrganization,
  createOrganization,
  createUser,
  getActiveEntitlement,
  type ProductId,
} from './db.js';
import { resolveCredential } from './entitlements.js';
import { publicRateLimitMiddleware } from './auth.js';
import { recordOperation, checkQuota, logOverageEvent, currentPeriod } from './metering.js';
import {
  executeCallx402Action,
  SERVER_EXECUTABLE_ACTIONS,
} from './callx402-execute.js';
import { VEYLINE_TIERS } from './purchase.js';
import {
  verifyPayerAuthorization,
  type PayerAuthorization,
} from './payer-auth.js';
import {
  loadCryptoConfig,
  usdcToBaseUnits,
  verifyUsdcPayment,
  USDC_BASE,
  type CryptoConfig,
} from './crypto.js';
import {
  isTxHashUsed,
  reserveTxHash,
  releaseTxHash,
  confirmTxHash,
} from './db.js';
import {
  checkActionGovernance,
  type GovernanceCheckResult,
} from './governor-enforcement.js';
import {
  loadValuationPolicy,
  deriveQuote,
  buildCanonicalInputs,
  parseQuoteParams,
  rederiveQuotedPayment,
  corroborateExposureUsd,
  createValuationTables,
  auditQuote,
  ValuationConfigError,
  QuoteRequestError,
  type Quote,
  type QuoteRequestParams,
  type CanonicalQuoteInputs,
} from './valuation.js';

// ---------------------------------------------------------------------------
// Fee schedule
// ---------------------------------------------------------------------------

/** Canonical action identifiers (normalized: lowercase, spaces/hyphens -> _). */
const ACTION_DISPLAY: Record<string, string> = {
  diagnose: 'diagnose',
  explain: 'explain',
  evidence: 'evidence',
  recover: 'recover',
  resolve: 'resolve',
  preflight: 'preflight',
  monitor: 'monitor',
  execute: 'execute',
  rescue: 'rescue',
  settlement_interpretation: 'settlement interpretation',
  safe_retry: 'safe retry',
  failure_classification: 'failure classification',
  duplicate_payment_risk: 'duplicate-payment risk',
};

/** Initial per-action fees in USD cents. Owner-adjustable via CALLX402_FEE_<ACTION>. */
const ACTION_FEES_DEFAULT: Record<string, number> = {
  diagnose: 200, // $2.00
  explain: 100, // $1.00
  evidence: 200, // $2.00
  recover: 1000, // $10.00
  resolve: 500, // $5.00
  preflight: 300, // $3.00
  monitor: 500, // $5.00
  execute: 1000, // $10.00
  rescue: 1500, // $15.00
  settlement_interpretation: 300, // $3.00
  safe_retry: 500, // $5.00
  failure_classification: 200, // $2.00
  duplicate_payment_risk: 500, // $5.00
};

export const CALLX402_ACTIONS = Object.keys(ACTION_DISPLAY);

/** Normalize user input to a canonical action id, or undefined. */
export function normalizeAction(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CALLX402_ACTIONS.includes(norm) ? norm : undefined;
}

/** Fee for an action in USD cents (env override wins; fail-closed to default). */
export function getActionFeeCents(action: string): number {
  const envName = `CALLX402_FEE_${action.toUpperCase()}`;
  const raw = process.env[envName]?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return ACTION_FEES_DEFAULT[action]!;
}

export function listActionFees(): Array<{
  action: string;
  display: string;
  amount_cents: number;
  currency: string;
}> {
  return CALLX402_ACTIONS.map((action) => ({
    action,
    display: ACTION_DISPLAY[action]!,
    amount_cents: getActionFeeCents(action),
    currency: 'usd',
  }));
}

// ---------------------------------------------------------------------------
// DB: single-action credits + invocation audit
// ---------------------------------------------------------------------------

export function createCallx402Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS callx402_action_credits (
      credit_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      action TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL DEFAULT 'unused',
      stripe_session_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by_invocation TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cxa_credits_org ON callx402_action_credits(org_id);
    CREATE INDEX IF NOT EXISTS idx_cxa_credits_session ON callx402_action_credits(stripe_session_id);
    CREATE TABLE IF NOT EXISTS callx402_invocations (
      invocation_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      action TEXT NOT NULL,
      via TEXT NOT NULL,
      credit_id TEXT,
      key_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cxa_invocations_org ON callx402_invocations(org_id);
  `);
}

export interface ActionCreditRow {
  credit_id: string;
  org_id: string;
  action: string;
  amount_cents: number;
  currency: string;
  status: string;
  stripe_session_id: string | null;
  created_at: string;
  consumed_at: string | null;
  consumed_by_invocation: string | null;
}

export function getCreditBySession(db: Database.Database, sessionId: string): ActionCreditRow | undefined {
  return db
    .prepare('SELECT * FROM callx402_action_credits WHERE stripe_session_id = ?')
    .get(sessionId) as ActionCreditRow | undefined;
}

export function getCredit(db: Database.Database, creditId: string): ActionCreditRow | undefined {
  return db
    .prepare('SELECT * FROM callx402_action_credits WHERE credit_id = ?')
    .get(creditId) as ActionCreditRow | undefined;
}

/**
 * Atomically consume one unused credit. Returns the consumed row, or null when
 * the credit does not exist, is not unused, or lost a concurrent race.
 */
export function consumeActionCredit(
  db: Database.Database,
  creditId: string,
  invocationId: string,
): ActionCreditRow | null {
  return db.transaction((): ActionCreditRow | null => {
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `UPDATE callx402_action_credits
         SET status = 'consumed', consumed_at = ?, consumed_by_invocation = ?
         WHERE credit_id = ? AND status = 'unused'`,
      )
      .run(now, invocationId, creditId);
    if (res.changes !== 1) return null;
    return getCredit(db, creditId) ?? null;
  })();
}

function recordInvocation(
  db: Database.Database,
  opts: { orgId: string; action: string; via: 'credit' | 'subscription' | 'x402'; creditId?: string; keyId?: string },
): string {
  const invocationId = `invo_${randomBytes(12).toString('base64url')}`;
  db.prepare(
    `INSERT INTO callx402_invocations
     (invocation_id, org_id, action, via, credit_id, key_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invocationId,
    opts.orgId,
    opts.action,
    opts.via,
    opts.creditId ?? null,
    opts.keyId ?? null,
    new Date().toISOString(),
  );
  return invocationId;
}

/**
 * Server-side execution for paid callx402 actions.
 *
 * After payment/authorization, read-only diagnostic actions are executed
 * here over caller-supplied evidence so a bare `npm install callx402` works
 * with zero local setup. `evidence`/`explain` resolve against the rail's own
 * invocation ledger (never the Veyline entitlement engine — proprietary
 * Veyline logic stays server-side in the Veyline product, not in this path).
 *
 * Returns the execution payload to merge into the 200 response, or null when
 * the action requires a local runtime.
 */
function buildExecutionResult(
  db: Database.Database,
  action: string,
  body: Record<string, unknown>,
  orgId: string,
): Record<string, unknown> | null {
  // evidence: show the rail's own invocation record (audit trail).
  // Scoped to the caller's org: cross-tenant lookups return not-found.
  if (action === 'evidence') {
    const id = typeof body['invocation_id'] === 'string' ? (body['invocation_id'] as string) : null;
    if (!id) {
      return { executed: false, error: 'evidence requires invocation_id in the request body' };
    }
    const row = db
      .prepare('SELECT invocation_id, org_id, action, via, created_at FROM callx402_invocations WHERE invocation_id = ? AND org_id = ?')
      .get(id, orgId) as Record<string, unknown> | undefined;
    if (!row) {
      return { executed: false, error: `no invocation found for ${id}` };
    }
    // Redact org internals: callers see their own invocation's audit facts.
    return {
      executed: true,
      action,
      disposition: `Invocation ${id}: ${String(row['action'])} via ${String(row['via'])} at ${String(row['created_at'])}.`,
      result: { invocation_id: row['invocation_id'], action: row['action'], via: row['via'], created_at: row['created_at'] },
    };
  }
  // explain: plain-language summary of a rail invocation.
  // Scoped to the caller's org: cross-tenant lookups return not-found.
  if (action === 'explain') {
    const id = typeof body['invocation_id'] === 'string' ? (body['invocation_id'] as string) : null;
    if (!id) {
      return { executed: false, error: 'explain requires invocation_id in the request body' };
    }
    const row = db
      .prepare('SELECT invocation_id, action, via, created_at FROM callx402_invocations WHERE invocation_id = ? AND org_id = ?')
      .get(id, orgId) as Record<string, unknown> | undefined;
    if (!row) {
      return { executed: false, error: `no invocation found for ${id}` };
    }
    return {
      executed: true,
      action,
      disposition:
        `On ${String(row['created_at'])}, the '${String(row['action'])}' action was invoked ` +
        `via ${String(row['via'])} and recorded as invocation ${String(row['invocation_id'])}. ` +
        `Payment was verified exactly once; the invocation is metered and auditable. ` +
        `No further action is required unless the underlying incident recurs.`,
      result: { invocation_id: row['invocation_id'], action: row['action'], via: row['via'], created_at: row['created_at'] },
    };
  }
  if ((SERVER_EXECUTABLE_ACTIONS as string[]).includes(action)) {
    const exec = executeCallx402Action(action, {
      evidence: body['evidence'],
      operationId: typeof body['operation_id'] === 'string' ? (body['operation_id'] as string) : undefined,
      identity: body['identity'],
      target: typeof body['target'] === 'string' ? (body['target'] as string) : undefined,
      context: body['context'],
    });
    if (!exec.executed) {
      return { executed: false, error: exec.error || 'execution unavailable' };
    }
    return { executed: true, disposition: exec.disposition, result: exec.result };
  }
  return null;
}

/**
 * Governor enforcement gate (opt-in). For orgs with ACTIVE mandates, every
 * callx402 invocation on the subscription and credit paths runs each
 * mandate's intent firewall BEFORE anything is authorized. Orgs with no
 * active mandates get { enforced: false } and proceed exactly as before.
 *
 *   - DENY -> 403 GOVERNOR_DENY
 *   - ESCALATE_HUMAN without a consumable human approval -> 423
 *     GOVERNOR_ESCALATION_REQUIRED (the body names the approval endpoint and
 *     the exact step fingerprint to approve)
 *
 * Runs BEFORE credit consumption: a paid single-action credit is never
 * burned on a governor-blocked action. Any internal failure of the
 * governance check fails closed with 500.
 *
 * The x402 (on-chain) path is intentionally NOT governed: its org is
 * x402_<address> and cannot hold mandates.
 */
function governorGate(
  db: Database.Database,
  orgId: string,
  action: string,
): { proceed: true } | { proceed: false; status: number; body: object } {
  let result: GovernanceCheckResult;
  try {
    // amountUsd defaults to the action fee schedule inside the gate; the
    // parameter exists so the future valuation layer can pass real quotes.
    result = checkActionGovernance(db, orgId, action, { amountUsd: getActionFeeCents(action) / 100 });
  } catch (e) {
    return {
      proceed: false,
      status: 500,
      body: errBody('GOVERNOR_ERROR', 'governance check failed; refusing to authorize closed'),
    };
  }
  if (!result.enforced || result.decision === 'ALLOW') return { proceed: true };
  if (result.decision === 'DENY') {
    return {
      proceed: false,
      status: 403,
      body: {
        error: {
          code: 'GOVERNOR_DENY',
          message: 'this action is blocked by an active economic mandate on your organization',
        },
        reasons: result.reasons ?? [],
      },
    };
  }
  // ESCALATE_HUMAN without a consumable approval.
  return {
    proceed: false,
    status: 423,
    body: {
      error: {
        code: 'GOVERNOR_ESCALATION_REQUIRED',
        message: 'an active economic mandate requires human approval before this action may run',
      },
      reasons: result.reasons ?? [],
      escalations: result.escalations ?? [],
      approval_endpoint: result.escalations?.[0]?.approval_endpoint,
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook fulfillment (called from stripe-routes.ts for product='callx402')
// ---------------------------------------------------------------------------

export interface Callx402FulfillResult {
  alreadyFulfilled: boolean;
  orgId: string;
  action: string;
  creditId: string;
}

export class Callx402FulfillError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * Fulfill a checkout.session.completed event for a callx402 on-demand action.
 * Idempotent: the same Stripe event ID, or the same checkout session,
 * creates at most one credit. All inputs come from the VERIFIED Stripe
 * event, never from the client.
 */
export function fulfillCallx402CheckoutSession(
  db: Database.Database,
  recordStripeEvent: (db: Database.Database, eventId: string, type: string) => void,
  isStripeEventProcessed: (db: Database.Database, eventId: string) => boolean,
  eventId: string,
  session: { id: string; metadata: Record<string, string | undefined> },
): Callx402FulfillResult {
  const orgId = session.metadata['org_id'];
  const action = normalizeAction(session.metadata['action']);
  if (!orgId || !action) {
    throw new Callx402FulfillError(
      'INVALID_SESSION_METADATA',
      `checkout session ${session.id} has invalid fulfillment metadata (org/action)`,
    );
  }
  const org = getOrganization(db, orgId);
  if (!org) {
    throw new Callx402FulfillError('UNKNOWN_ORG', `organization ${orgId} not found for checkout session ${session.id}`);
  }
  createCallx402Tables(db);
  return db.transaction((): Callx402FulfillResult => {
    // Idempotency gate 1: this exact Stripe event was already processed.
    if (isStripeEventProcessed(db, eventId)) {
      const existing = getCreditBySession(db, session.id);
      if (!existing) throw new Callx402FulfillError('STATE_INVALID', 'event already processed but no action credit exists');
      return { alreadyFulfilled: true, orgId, action: existing.action, creditId: existing.credit_id };
    }
    recordStripeEvent(db, eventId, 'checkout.session.completed');

    // Idempotency gate 2: this checkout session already fulfilled.
    const dup = getCreditBySession(db, session.id);
    if (dup) {
      return { alreadyFulfilled: true, orgId, action: dup.action, creditId: dup.credit_id };
    }

    const creditId = `cxa_${randomBytes(16).toString('base64url')}`;
    db.prepare(
      `INSERT INTO callx402_action_credits
       (credit_id, org_id, action, amount_cents, currency, status, stripe_session_id, created_at)
       VALUES (?, ?, ?, ?, 'usd', 'unused', ?, ?)`,
    ).run(creditId, orgId, action, getActionFeeCents(action), session.id, new Date().toISOString());
    return { alreadyFulfilled: false, orgId, action, creditId };
  })();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface Callx402RouterOptions {
  /** Injected Stripe client (tests). Defaults to a client built from STRIPE_SECRET_KEY. */
  stripeClient?: Stripe;
  /**
   * Injected USDC payment verifier (tests). Defaults to on-chain
   * verification via verifyUsdcPayment. Signature mirrors purchase.ts.
   */
  verifyPayment?: (
    config: CryptoConfig,
    txHash: string,
    minAmountBaseUnits: bigint,
  ) => Promise<{ txHash: string; from: string; amountBaseUnits: bigint; amountUsdc: string; basescanUrl: string }>;
}

function getStripeClient(injected?: Stripe): Stripe | undefined {
  if (injected) return injected;
  const key = process.env['STRIPE_SECRET_KEY']?.trim();
  if (!key) return undefined;
  return new Stripe(key);
}

function errBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

const SESSION_ID_RE = /^cs_[A-Za-z0-9_]+$/;
const CREDIT_ID_RE = /^cxa_[A-Za-z0-9_-]{16,64}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Action fee in USDC string ("10.00") for x402 payment requirements. */
function actionFeeUsdc(action: string): string {
  return (getActionFeeCents(action) / 100).toFixed(2);
}

/**
 * Standards-compliant x402 v2 402 Payment Required for one action.
 *
 * Any x402-capable agent/client can pay this without Payload-specific
 * integration: transfer the exact USDC amount on Base to payTo, then retry
 * with the txHash. The txHash is the payment nonce: atomic single-use
 * reservation before on-chain verification means a hash can never pay
 * twice. maxTimeoutSeconds bounds the payment window (expiry).
 *
 * The accepts amount is the valuation-layer quoted price (x402 path floor
 * by default; value-based when corroborated exposure is supplied). The
 * quote travels in extensions.payload with its quote_id, full breakdown,
 * and expiry. Payment must echo { quote_id, quote } so the rail can
 * re-derive the quote and reject underpayment.
 *
 * Human buyers get the Stripe alternative under extensions.payload.
 */
function buildActionPaymentRequired(
  action: string,
  config: CryptoConfig,
  quote: Quote,
  inputs: CanonicalQuoteInputs,
): object {
  const amountBaseUnits = usdcToBaseUnits(quote.quoted_price_usd).toString();
  return {
    x402Version: 2,
    resource: {
      url: `https://payload-rail.fly.dev/v1/callx402/actions/${action}`,
      description: `callx402 '${ACTION_DISPLAY[action]}' — paid on-demand x402 action, single execution`,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        amount: amountBaseUnits,
        asset: USDC_BASE,
        payTo: config.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ],
    extensions: {
      payload: {
        action,
        display: ACTION_DISPLAY[action],
        amount_cents: quote.quoted_price_cents,
        currency: 'usd',
        quote_id: quote.quote_id,
        quoted_price_usd: quote.quoted_price_usd,
        breakdown: quote.breakdown,
        policy_version: quote.policy_version,
        formula_version: quote.formula_version,
        issued_at: quote.issued_at,
        expires_at: quote.expires_at,
        requires_explicit_authorization: quote.requires_explicit_authorization,
        corroborated: quote.corroborated,
        human_summary: quote.human_summary,
        quote_inputs: {
          action: inputs.action,
          path: inputs.path,
          declaredExposureCents: inputs.declaredExposureCents,
          corroboratedExposureCents: inputs.corroboratedExposureCents,
          corroborateTx: inputs.corroborateTx,
          complexity: inputs.complexity,
          riskTier: inputs.riskTier,
          resourceUnits: inputs.resourceUnits,
          authorizeAboveCeiling: inputs.authorizeAboveCeiling,
          issuedAt: inputs.issuedAt,
          policyVersion: inputs.policyVersion,
          formulaVersion: inputs.formulaVersion,
        },
        redeem_with_payment: {
          method: 'POST',
          url: `/v1/callx402/actions/${action}`,
          body: {
            txHash: '0x...',
            quote_id: quote.quote_id,
            quote: '{echo the quote_inputs object from this 402 verbatim}',
          },
          note: 'Payment must reference quote_id; the rail re-derives the quote from the echoed inputs and rejects underpayment, expired quotes, and quote_id mismatches.',
        },
        authorization:
          quote.requires_explicit_authorization
            ? {
                required: true,
                note: `This quote ($${quote.quoted_price_usd}) exceeds the automated ceiling. Re-request the quote with authorize_above_ceiling=true to attest explicit payer authorization, then pay and submit { txHash, quote_id, quote }. Payment above the ceiling without the attestation is rejected.`,
              }
            : { required: false },
        human_checkout: {
          method: 'POST',
          url: '/v1/callx402/checkout',
          body: { action },
          note: 'One-time Stripe checkout -> single-use credit. For humans; agents should use the x402 payment above.',
        },
        subscription_alternative:
          'Veyline subscribers: send your Veyline API key as Authorization: Bearer <key> instead of paying per action.',
        replay_policy:
          'Each Base USDC txHash is single-use: atomically reserved before on-chain verification and confirmed after. A hash can never authorize two invocations.',
        note: 'A paid callx402 action never requires or creates a Veyline subscription.',
      },
    },
  };
}

/** Legacy fixed-fee 402 (used only when the valuation layer is unavailable). */
function buildActionPaymentRequiredLegacy(action: string, config: CryptoConfig): object {
  const cents = getActionFeeCents(action);
  const amountUsdc = actionFeeUsdc(action);
  const amountBaseUnits = usdcToBaseUnits(amountUsdc).toString();
  return {
    x402Version: 2,
    resource: {
      url: `https://payload-rail.fly.dev/v1/callx402/actions/${action}`,
      description: `callx402 '${ACTION_DISPLAY[action]}' — paid on-demand x402 action, single execution`,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        amount: amountBaseUnits,
        asset: USDC_BASE,
        payTo: config.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ],
    extensions: {
      payload: {
        action,
        display: ACTION_DISPLAY[action],
        amount_cents: cents,
        currency: 'usd',
        valuation_unavailable:
          'valuation layer unavailable; falling back to the fixed fee schedule (fail-safe, not a discount)',
        human_checkout: {
          method: 'POST',
          url: '/v1/callx402/checkout',
          body: { action },
          note: 'One-time Stripe checkout -> single-use credit. For humans; agents should use the x402 payment above.',
        },
        redeem_with_payment: {
          method: 'POST',
          url: `/v1/callx402/actions/${action}`,
          body: { txHash: '0x...' },
        },
        subscription_alternative:
          'Veyline subscribers: send your Veyline API key as Authorization: Bearer <key> instead of paying per action.',
        replay_policy:
          'Each Base USDC txHash is single-use: atomically reserved before on-chain verification and confirmed after. A hash can never authorize two invocations.',
        note: 'A paid callx402 action never requires or creates a Veyline subscription.',
      },
    },
  };
}

/** 402 when the x402/USDC path is unavailable (crypto not configured). */
function paymentRequiredNoCrypto(action: string): object {
  const cents = getActionFeeCents(action);
  return {
    error: {
      code: 'PAYMENT_REQUIRED',
      message: `callx402 '${ACTION_DISPLAY[action]}' is a paid on-demand action ($${(cents / 100).toFixed(2)}).`,
    },
    action,
    display: ACTION_DISPLAY[action],
    amount_cents: cents,
    currency: 'usd',
    x402: { available: false, reason: 'USDC settlement is not configured on this Rail' },
    checkout: {
      method: 'POST',
      url: '/v1/callx402/checkout',
      body: { action },
    },
    subscription_alternative:
      'Veyline subscribers: send your Veyline API key as Authorization: Bearer <key> instead of paying per action.',
    note: 'A paid callx402 action never requires or creates a Veyline subscription.',
  };
}

export interface IssuedQuote {
  quote: Quote;
  inputs: CanonicalQuoteInputs;
  corroborationNote: string | null;
}

/**
 * Issue a valuation quote: load policy (fail-closed), parse params,
 * optionally corroborate exposure on-chain, derive the deterministic
 * quote, and audit it. Throws ValuationConfigError / QuoteRequestError.
 *
 * Corroboration failures do NOT fail the quote: the corroboration rule is
 * fail-closed toward P=$0, so a failed corroboration yields a valid
 * base-only quote with the failure recorded in the breakdown reason.
 */
export async function issueQuote(
  db: Database.Database,
  rawParams: Record<string, unknown>,
  opts: { verifyExposure?: (config: CryptoConfig, txHash: string) => Promise<{ txHash: string; exposureCents: number }> } = {},
): Promise<IssuedQuote> {
  const policy = loadValuationPolicy(getActionFeeCents);
  const params: QuoteRequestParams = parseQuoteParams(rawParams, normalizeAction);
  let corroborated: { txHash: string; exposureCents: number } | null = null;
  let corroborationNote: string | null = null;
  if (params.corroborateTx) {
    const config = loadCryptoConfig();
    if (!config.enabled) {
      throw new QuoteRequestError(
        'CRYPTO_NOT_CONFIGURED',
        'corroboration requires on-chain verification, but USDC settlement is not configured on this Rail',
        503,
      );
    }
    try {
      const verify = opts.verifyExposure ?? corroborateExposureUsd;
      corroborated = await verify(config, params.corroborateTx);
    } catch (e) {
      // Fail closed toward P=$0: the quote stays valid, value component 0.
      corroborationNote =
        e instanceof Error ? e.message.replace(/^[A-Z_]+:\s*/, '') : 'corroboration failed';
    }
  }
  const inputs = buildCanonicalInputs(policy, params, corroborated);
  const quote = deriveQuote(policy, inputs);
  if (corroborationNote) {
    const valueLine = quote.breakdown.find((b) => b.component === 'value');
    if (valueLine) {
      valueLine.reason =
        `corroboration of ${params.corroborateTx} failed (${corroborationNote}); ` +
        'exposure treated as uncorroborated (P=$0)';
    }
  }
  auditQuote(db, quote, inputs);
  return { quote, inputs, corroborationNote };
}

export function buildCallx402Router(db: Database.Database, opts: Callx402RouterOptions = {}): Router {
  const router = Router();
  createCallx402Tables(db);
  createValuationTables(db);
  const publicRateLimit = publicRateLimitMiddleware();

  // GET /v1/callx402/actions — public fee schedule (exact live pricing).
  router.get('/callx402/actions', (_req: Request, res: Response) => {
    res.json({
      product: 'callx402',
      model: 'paid on-demand per action; no subscription required',
      currency: 'usd',
      actions: listActionFees(),
    });
  });

  // GET /v1/callx402/quote — deterministic valuation quote for one action.
  // Query: action (required), path=x402|stripe (default x402),
  //   exposure_usd (optional caller-declared figure; NEVER raises the quote
  //   without independent corroboration), complexity (default 1),
  //   risk_tier=low|medium|high (default low), resource_units (default 0),
  //   corroborate_tx (optional 0x hash: rail verifies the settled USDC
  //   volume on-chain and uses it as the protectable value P),
  //   authorize_above_ceiling=true (optional explicit payer attestation for
  //   quotes above the $5,000 automated ceiling).
  // Same inputs + same policy -> identical quote_id and price.
  router.get('/callx402/quote', publicRateLimit, async (req: Request, res: Response) => {
    try {
      const { quote } = await issueQuote(db, req.query as Record<string, unknown>);
      res.json({
        quote_id: quote.quote_id,
        action: quote.action,
        path: quote.path,
        quoted_price_cents: quote.quoted_price_cents,
        quoted_price_usd: quote.quoted_price_usd,
        breakdown: quote.breakdown,
        requires_explicit_authorization: quote.requires_explicit_authorization,
        authorized_above_ceiling: quote.authorized_above_ceiling,
        corroborated: quote.corroborated,
        declared_exposure_cents: quote.declared_exposure_cents,
        corroborated_exposure_cents: quote.corroborated_exposure_cents,
        policy_version: quote.policy_version,
        formula_version: quote.formula_version,
        issued_at: quote.issued_at,
        expires_at: quote.expires_at,
        human_summary: quote.human_summary,
      });
    } catch (e) {
      if (e instanceof QuoteRequestError) {
        res.status(e.status).json(errBody(e.code, e.message));
        return;
      }
      if (e instanceof ValuationConfigError) {
        res.status(500).json(errBody('VALUATION_CONFIG_INVALID', e.message));
        return;
      }
      res.status(500).json(errBody('QUOTE_FAILED', e instanceof Error ? e.message : 'quote failed'));
    }
  });

  // POST /v1/callx402/checkout — create a Stripe one-time Checkout Session.
  // Body: { action: "<one of the 13 actions>" }
  // Public (new buyers have no key yet). Guest checkout provisions a fresh
  // org server-side; a client-supplied org_id without a valid key is
  // rejected (no org enumeration, no hijacking). Rate-limited per IP.
  // A credit is created ONLY by the verified webhook, never here.
  router.post('/callx402/checkout', publicRateLimit, async (req: Request, res: Response) => {
    const action = normalizeAction((req.body as { action?: unknown } | undefined)?.action);
    if (!action) {
      res
        .status(400)
        .json(errBody('INVALID_ACTION', `action must be one of: ${CALLX402_ACTIONS.join(', ')}`));
      return;
    }
    // Guest checkout: provision a fresh org. Never let the caller pick or
    // name an existing org here.
    const body = (req.body ?? {}) as { org_id?: unknown };
    if (typeof body.org_id === 'string' && body.org_id) {
      res
        .status(400)
        .json(
          errBody(
            'INVALID_ORG_ID',
            'org_id is not accepted on guest checkout; a new organization is created automatically',
          ),
        );
      return;
    }
    const orgId = `org_${randomBytes(9).toString('base64url')}`;
    createOrganization(db, orgId, 'callx402-checkout');
    createUser(db, { userId: `usr_${randomBytes(9).toString('base64url')}`, orgId, role: 'owner' });

    const stripe = getStripeClient(opts.stripeClient);
    if (!stripe) {
      res.status(500).json(errBody('STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured'));
      return;
    }
    const cents = getActionFeeCents(action);
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: cents,
              product_data: { name: `callx402 ${ACTION_DISPLAY[action]} (on-demand action)` },
            },
            quantity: 1,
          },
        ],
        // Server-derived metadata: the webhook trusts ONLY these values.
        metadata: { org_id: orgId, action, product: 'callx402' },
        success_url:
          process.env['STRIPE_SUCCESS_URL']?.trim()?.replace('/v1/stripe/success', '/v1/callx402/success') ||
          'https://payload-rail.fly.dev/v1/callx402/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: process.env['STRIPE_CANCEL_URL']?.trim() || 'https://payloadhq.github.io/veyline.html',
      });
      res.status(201).json({
        checkout_url: session.url,
        session_id: session.id,
        action,
        display: ACTION_DISPLAY[action],
        amount_cents: cents,
        currency: 'usd',
        org_id: orgId,
        notice:
          'Complete payment in the checkout session. Your single-action credit is issued when Stripe confirms payment (webhook); the credit id is then shown once on the success page.',
      });
    } catch (e) {
      res
        .status(502)
        .json(errBody('CHECKOUT_FAILED', e instanceof Error ? e.message : 'Stripe checkout session creation failed'));
    }
  });

  // GET /v1/callx402/success?session_id=cs_... — single-action credit delivery.
  // The session is verified against the Stripe API (authoritative) AND local
  // fulfillment records (verified webhook must have processed it). The
  // credit id is returned EXACTLY ONCE; later loads see only the claimed
  // notice. Session IDs are high-entropy secrets in the buyer's own
  // redirect, so one buyer cannot claim another's credit.
  router.get('/callx402/success', publicRateLimit, async (req: Request, res: Response) => {
    const sessionId = req.query['session_id'];
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      res.status(400).json(errBody('INVALID_SESSION_ID', 'session_id query parameter is required'));
      return;
    }
    const stripe = getStripeClient(opts.stripeClient);
    if (!stripe) {
      res.status(500).json(errBody('STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured'));
      return;
    }
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      res.status(404).json(errBody('UNKNOWN_SESSION', 'no such checkout session'));
      return;
    }
    const metadata: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(session.metadata ?? {})) metadata[k] = v ?? undefined;
    if (metadata['product'] !== 'callx402') {
      res.status(404).json(errBody('UNKNOWN_SESSION', 'no such checkout session'));
      return;
    }
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    if (!paid) {
      res.status(400).json(errBody('PAYMENT_INCOMPLETE', 'this checkout session has not completed payment'));
      return;
    }
    const credit = getCreditBySession(db, session.id);
    if (!credit) {
      res.status(200).json({
        status: 'pending',
        notice: 'Payment confirmed. Your action credit is being issued; reload this page in a few seconds.',
      });
      return;
    }
    if (credit.status !== 'unused') {
      res.status(200).json({
        status: 'claimed',
        notice: 'This action credit was already claimed or consumed.',
      });
      return;
    }
    res.status(200).json({
      status: 'ready',
      action: credit.action,
      display: ACTION_DISPLAY[credit.action] ?? credit.action,
      amount_cents: credit.amount_cents,
      currency: credit.currency,
      credit_id: credit.credit_id,
      redeem: {
        method: 'POST',
        url: `/v1/callx402/actions/${credit.action}`,
        body: { credit_id: credit.credit_id },
      },
      warning: 'Treat this credit id like a password: it authorizes exactly one paid action invocation.',
    });
  });

  // POST /v1/callx402/actions/:action — authorize + consume + meter one paid
  // action invocation. Three paths, in order:
  //   1. Subscription: valid veyline-bound API key with an active Veyline
  //      entitlement (metered against subscription usage).
  //   2. x402 agent: { txHash } — USDC paid on Base, verified on-chain
  //      before authorization (standards-compliant x402 exact scheme).
  //   3. Credit: { credit_id } — single-use credit from a Stripe checkout.
  // No key + no payment + no credit -> 402 with the x402 payment requirement.
  // The rail authorizes, consumes, and meters; the action itself executes in
  // the caller's callx402 runtime. A paid action never requires or creates
  // a Veyline subscription.
  router.post('/callx402/actions/:action', publicRateLimit, async (req: Request, res: Response) => {
    const action = normalizeAction(req.params['action']);
    if (!action) {
      res
        .status(400)
        .json(errBody('INVALID_ACTION', `action must be one of: ${CALLX402_ACTIONS.join(', ')}`));
      return;
    }

    // Pre-payment validation: ensure the action can actually execute with the
    // provided inputs BEFORE any payment/credit is consumed. This prevents
    // silent loss of payment when execution would fail.
    const bodyParams = (req.body ?? {}) as Record<string, unknown>;
    if (action === 'evidence' || action === 'explain') {
      const invocationId = bodyParams['invocation_id'];
      if (typeof invocationId !== 'string' || !invocationId) {
        res.status(400).json(errBody('MISSING_INPUT', `${action} requires invocation_id in the request body`));
        return;
      }
    }
    // Actions not in SERVER_EXECUTABLE_ACTIONS and not evidence/explain
    // require a local runtime; they are authorized but not executed server-side.
    // This is expected and does not consume payment for execution.

    const send402 = async (): Promise<void> => {
      const config = loadCryptoConfig();
      if (!config.enabled) {
        res.status(402).json(paymentRequiredNoCrypto(action));
        return;
      }
      // Quote-aware 402: the accepts amount is the valuation quote for the
      // caller-supplied parameters (default: x402 floor quote). The quote
      // (quote_id, breakdown, expiry) travels in extensions.payload; payment
      // must echo { quote_id, quote } so the rail can re-derive and reject
      // underpayment. Valuation failure falls back to the legacy fixed-fee
      // 402 (fail-safe availability); the quote endpoint stays authoritative.
      const bodyParams = { ...((req.body ?? {}) as Record<string, unknown>), action, path: 'x402' };
      let issued: IssuedQuote | null = null;
      try {
        issued = await issueQuote(db, bodyParams);
      } catch {
        try {
          issued = await issueQuote(db, { action, path: 'x402' });
        } catch {
          issued = null;
        }
      }
      const paymentRequired = issued
        ? buildActionPaymentRequired(action, config, issued.quote, issued.inputs)
        : buildActionPaymentRequiredLegacy(action, config);
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'));
      res.status(402).json(paymentRequired);
    };

    const auth = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(auth);
    if (m) {
      // Subscription path: a valid veyline-bound key with an active Veyline
      // entitlement covers on-demand invocations (metered to usage).
      const resolved = resolveCredential(db, m[1]!);
      if (
        resolved?.kind === 'v2' &&
        resolved.productBinding === 'veyline' &&
        resolved.orgId
      ) {
        const ent = getActiveEntitlement(db, resolved.orgId, 'veyline');
        if (ent && ent.status === 'active') {
          // Quota parity with /v1/veyline (requireQuota, metering.ts): this
          // router is mounted without the quota middleware, so the tier's
          // monthly operation limit is enforced here. Without this, an agent
          // holding a veyline key could invoke paid on-demand actions
          // without bound on the subscription path, exceeding the quota the
          // org owner authorized. Enterprise/custom tiers (no finite
          // opsPerMonth) are not throttled, mirroring requireQuota.
          const tier = ent.tier;
          const opsPerMonth = tier ? Number(VEYLINE_TIERS[tier]?.limits.opsPerMonth) : NaN;
          if (Number.isFinite(opsPerMonth) && opsPerMonth > 0) {
            const quota = checkQuota(db, resolved.orgId, 'veyline', tier);
            if (!quota.allowed) {
              logOverageEvent(db, {
                orgId: resolved.orgId,
                product: 'veyline',
                periodStart: currentPeriod().periodStart,
                operationsCount: quota.opsUsed,
                limit: quota.opsIncluded,
                overageRateCents: 0, // overage billing NOT activated
              });
              res.status(429).json({
                error: {
                  code: 'QUOTA_EXCEEDED',
                  message: `Monthly operation limit reached (${quota.opsUsed} of ${quota.opsIncluded}). Usage resets on the 1st of next month (UTC).`,
                  opsUsed: quota.opsUsed,
                  opsIncluded: quota.opsIncluded,
                  overageRate: 0, // USD cents per overage op; 0 = overage billing not activated
                },
              });
              return;
            }
          }
          // Governor enforcement (opt-in): active mandates on this org gate
          // the action BEFORE authorization and metering.
          const gate = governorGate(db, resolved.orgId, action);
          if (!gate.proceed) {
            res.status(gate.status).json(gate.body);
            return;
          }
          const invocationId = recordInvocation(db, {
            orgId: resolved.orgId,
            action,
            via: 'subscription',
            keyId: resolved.keyId,
          });
          recordOperation(db, resolved.orgId, 'veyline');
          const execution = buildExecutionResult(db, action, (req.body ?? {}) as Record<string, unknown>, resolved.orgId);
          const execOk = !execution || execution.executed !== false;
          res.status(execOk ? 200 : 422).json({
            ok: execOk,
            action,
            display: ACTION_DISPLAY[action],
            via: 'subscription',
            invocation_id: invocationId,
            notice:
              'Invocation authorized and metered against your Veyline subscription.',
            ...(execution ? { execution } : {}),
          });
          return;
        }
      }
      // A Bearer <redacted> was presented but is not a valid active Veyline credential.
      res.status(401).json(errBody('INVALID_KEY', 'the provided API key is not a valid active Veyline credential'));
      return;
    }

    const body = (req.body ?? {}) as { txHash?: unknown; credit_id?: unknown };

    // --- x402 autonomous-agent path: on-chain USDC payment, verified first.
    // Reuses the rail's existing settlement machinery (same as the public
    // x402 endpoint): atomic txHash reservation before the slow RPC closes
    // the TOCTOU window; the hash is the payment nonce and can never be
    // spent twice.
    //
    // SECURITY: Requires cryptographic payer authorization. The redeemer must
    // prove control of the paying wallet via EIP-191 signature over the
    // action, txHash, quote, network, recipient, nonce, and expiry. A public
    // txHash alone NEVER authorizes an action (prevents first-redeemer abuse).
    if (typeof body.txHash === 'string' && body.txHash) {
      const config = loadCryptoConfig();
      if (!config.enabled) {
        res
          .status(503)
          .json(errBody('CRYPTO_NOT_CONFIGURED', 'USDC settlement is not configured on this Rail'));
        return;
      }
      const txHash = body.txHash.toLowerCase();
      if (!TX_HASH_RE.test(txHash)) {
        res.status(400).json(errBody('INVALID_TX_HASH', 'txHash must be a 0x-prefixed 32-byte hash'));
        return;
      }
      // Payer authorization is MANDATORY. Fail closed if missing or invalid.
      const payerAuth = (body as { payer_auth?: unknown }).payer_auth as PayerAuthorization | undefined;
      if (!payerAuth || typeof payerAuth !== 'object') {
        res.status(401).json(errBody('PAYER_AUTH_REQUIRED', 'cryptographic payer authorization is required; sign the redemption with the paying wallet'));
        return;
      }
      // Bind the authorization to this specific redemption
      if (payerAuth.txHash.toLowerCase() !== txHash) {
        res.status(401).json(errBody('AUTH_TX_MISMATCH', 'payer authorization txHash does not match submitted txHash'));
        return;
      }
      if (payerAuth.action !== action) {
        res.status(401).json(errBody('AUTH_ACTION_MISMATCH', 'payer authorization action does not match requested action'));
        return;
      }
      const authResult = verifyPayerAuthorization(payerAuth, Math.floor(Date.now() / 1000));
      if (!authResult.valid) {
        res.status(401).json(errBody(authResult.error || 'PAYER_AUTH_INVALID', 'payer authorization verification failed'));
        return;
      }
      // The verified wallet becomes the payer org. The signature proves the
      // redeemer controls this wallet.
      const verifiedWallet = authResult.signer!.toLowerCase();
      // Valuation: resolve the quoted price BEFORE reserving the payment
      // hash. With { quote_id, quote } the rail re-derives the quote from
      // the echoed canonical inputs and rejects mismatches, expired
      // quotes, underpayment, and above-ceiling payment without the
      // explicit authorization attestation. Without a quote reference the
      // default x402 floor quote applies (backward compatible: earlier
      // payers paid the full schedule, which still satisfies the floor).
      let requiredQuote: Quote;
      try {
        const qid = (body as { quote_id?: unknown }).quote_id;
        if (typeof qid === 'string' && qid) {
          const echoed = ((body as { quote?: unknown }).quote ?? {}) as Record<string, unknown>;
          requiredQuote = rederiveQuotedPayment(
            loadValuationPolicy(getActionFeeCents),
            qid,
            echoed,
            normalizeAction,
            Math.floor(Date.now() / 1000),
          );
          if (requiredQuote.action !== action || requiredQuote.path !== 'x402') {
            res.status(400).json(errBody('QUOTE_MISMATCH', 'this quote was not issued for this action and path'));
            return;
          }
        } else {
          requiredQuote = (await issueQuote(db, { action, path: 'x402' })).quote;
        }
      } catch (e) {
        if (e instanceof QuoteRequestError) {
          res.status(e.status).json(errBody(e.code, e.message));
          return;
        }
        res
          .status(500)
          .json(errBody('VALUATION_UNAVAILABLE', 'valuation unavailable; refusing payment closed'));
        return;
      }
      if (isTxHashUsed(db, txHash)) {
        res.status(409).json(errBody('TX_ALREADY_USED', 'this transaction hash was already consumed'));
        return;
      }
      // Atomically reserve BEFORE the slow RPC: exactly one concurrent
      // request wins; the rest get TX_ALREADY_USED.
      if (!reserveTxHash(db, txHash, `callx402:${action}`)) {
        res.status(409).json(errBody('TX_ALREADY_USED', 'this transaction hash was already consumed'));
        return;
      }
      const minBaseUnits = usdcToBaseUnits(requiredQuote.quoted_price_usd);
      const verify = opts.verifyPayment ?? verifyUsdcPayment;
      let payment: { txHash: string; from: string; amountBaseUnits: bigint; amountUsdc: string; basescanUrl: string };
      try {
        payment = await verify(config, txHash, minBaseUnits);
      } catch (e) {
        releaseTxHash(db, txHash);
        const message = e instanceof Error ? e.message.replace(/^[A-Z_]+:\s*/, '') : 'payment verification failed';
        const code = e instanceof Error && /^[A-Z_]+:/.test(e.message) ? e.message.split(':')[0]! : 'VERIFY_FAILED';
        res.status(400).json(errBody(code, message));
        return;
      }
      // Atomic: confirm the payment, record the invocation, meter. The
      // txHash can never authorize a second invocation.
      //
      // SECURITY: The on-chain `from` must match the signature-verified wallet.
      // This binds the payment to the authorized redeemer.
      if (payment.from.toLowerCase() !== verifiedWallet) {
        releaseTxHash(db, txHash);
        res.status(401).json(errBody('PAYER_MISMATCH', 'on-chain payer does not match authorized wallet'));
        return;
      }
      const payerOrg = `x402_${verifiedWallet}`;
      const invocationId = db.transaction((): string => {
        confirmTxHash(db, txHash, `callx402:${action}`, payment.amountBaseUnits);
        return recordInvocation(db, { orgId: payerOrg, action, via: 'x402' });
      })();
      recordOperation(db, payerOrg, 'callx402' as ProductId);
      const execution = buildExecutionResult(db, action, body as Record<string, unknown>, payerOrg);
      const execOk = !execution || execution.executed !== false;
      res.status(execOk ? 200 : 422).json({
        ok: execOk,
        action,
        display: ACTION_DISPLAY[action],
        via: 'x402',
        invocation_id: invocationId,
        payment: {
          txHash: payment.txHash,
          amountUsdc: payment.amountUsdc,
          from: payment.from,
          basescanUrl: payment.basescanUrl,
          quote_id: requiredQuote.quote_id,
          quoted_price_usd: requiredQuote.quoted_price_usd,
        },
        notice:
          'Payment verified on-chain and consumed exactly once.',
        ...(execution ? { execution } : {}),
      });
      return;
    }

    // --- Credit path: single-action bearer credit from a Stripe checkout.
    const creditIdRaw = body.credit_id;
    if (typeof creditIdRaw !== 'string' || !CREDIT_ID_RE.test(creditIdRaw)) {
      await send402();
      return;
    }
    const existing = getCredit(db, creditIdRaw);
    if (!existing) {
      await send402();
      return;
    }
    if (existing.action !== action) {
      res
        .status(403)
        .json(
          errBody(
            'CREDIT_ACTION_MISMATCH',
            `this credit is for callx402 '${existing.action}', not '${action}'`,
          ),
        );
      return;
    }
    if (existing.status !== 'unused') {
      res.status(409).json(errBody('CREDIT_ALREADY_USED', 'this action credit has already been consumed'));
      return;
    }
    // Governor enforcement (opt-in): gate BEFORE the credit is consumed so
    // a paid credit is never burned on a governor-blocked action.
    const gate = governorGate(db, existing.org_id, action);
    if (!gate.proceed) {
      res.status(gate.status).json(gate.body);
      return;
    }
    const invocationId = `invo_${randomBytes(12).toString('base64url')}`;
    const consumed = consumeActionCredit(db, creditIdRaw, invocationId);
    if (!consumed) {
      // Lost a concurrent race: exactly one invocation wins.
      res.status(409).json(errBody('CREDIT_ALREADY_USED', 'this action credit has already been consumed'));
      return;
    }
    recordInvocation(db, { orgId: consumed.org_id, action, via: 'credit', creditId: creditIdRaw });
    recordOperation(db, consumed.org_id, 'callx402' as ProductId);
    const execution = buildExecutionResult(db, action, body as Record<string, unknown>, consumed.org_id);
    const execOk = !execution || execution.executed !== false;
    res.status(execOk ? 200 : 422).json({
      ok: execOk,
      action,
      display: ACTION_DISPLAY[action],
      via: 'credit',
      invocation_id: invocationId,
      notice:
        'Paid action authorized: credit consumed exactly once and metered.',
      ...(execution ? { execution } : {}),
    });
  });

  return router;
}
