/**
 * rail/src/callx402-execute.ts — server-side execution of callx402 actions.
 *
 * The hosted rail authorizes and meters paid actions; this module EXECUTES
 * the read-only diagnostic actions server-side so a bare `npm install
 * callx402` works with zero local setup. The npm package is a lightweight
 * client: invoke -> free quote -> payment/authorization -> result.
 *
 * Diagnostic logic is vendored from the x402 Paid API Starter Kit v2.0.0
 * (src/vendor/v2/, zero-dependency CJS). No Veyline proprietary logic is
 * included or executed here: evidence/explain resolve against the rail's own
 * invocation ledger, never the Veyline entitlement engine.
 *
 * All executions are read-only analysis over caller-supplied evidence.
 * Nothing here signs, retries, repays, or moves money.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Feature flags for the vendored modules (server-side: enabled).
// Rescue stays flag-gated and is NOT force-enabled.
process.env.PAYLOAD_SETTLEMENT_RESOLVER ??= '1';
process.env.PAYLOAD_MCP_DOCTOR ??= '1';

const vendorPkg = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'vendor',
  'v2',
  'package.json',
);
const v2require = createRequire(vendorPkg);

function loadV2(relativePath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return v2require(`./${relativePath}`);
}

let settlementResolver: any = null;
let mcpDoctor: any = null;
let classifier: any = null;
let preflightMod: any = null;

function getSettlementResolver(): any {
  if (!settlementResolver) settlementResolver = loadV2('lib/settlement-resolver.js');
  return settlementResolver;
}
function getMcpDoctor(): any {
  if (!mcpDoctor) mcpDoctor = loadV2('lib/mcp/doctor.js');
  return mcpDoctor;
}
function getClassifier(): any {
  if (!classifier) classifier = loadV2('lib/classify.js');
  return classifier;
}
function getPreflight(): any {
  if (!preflightMod) preflightMod = loadV2('lib/mcp/preflight.js');
  return preflightMod;
}

export interface ExecuteInput {
  evidence?: unknown;
  operationId?: string;
  identity?: unknown;
  target?: string;
  context?: unknown;
}

export interface ExecuteResult {
  executed: boolean;
  action: string;
  result?: unknown;
  disposition?: string;
  error?: string;
}

function parseEvidence(input: ExecuteInput): any {
  const raw = input.evidence ?? input.context ?? {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { rawText: raw };
    }
  }
  return raw ?? {};
}

/**
 * Execute a read-only diagnostic action server-side.
 * Returns { executed: false } for actions that require a local runtime.
 */
export function executeCallx402Action(
  action: string,
  input: ExecuteInput,
): ExecuteResult {
  const evidence = parseEvidence(input);
  try {
    switch (action) {
      case 'diagnose': {
        const report = getMcpDoctor().runMcpDoctor(evidence);
        const whatFailed = report?.whatFailed || 'unknown';
        return {
          executed: true,
          action,
          disposition: `Diagnosis complete: ${whatFailed}.`,
          result: report,
        };
      }
      case 'resolve': {
        const r = getSettlementResolver().resolve(evidence);
        const state = r?.state || 'UNKNOWN';
        const disposition =
          state === 'UNKNOWN'
            ? 'Settlement UNKNOWN: no auto-retry, no repay. Gather fresh evidence.'
            : `Settlement resolved: ${state} (${r.confidence || 'n/a'} confidence).` +
              (r.policy ? ` Policy: ${r.policy.retry}.` : '');
        return { executed: true, action, disposition, result: r };
      }
      case 'settlement_interpretation': {
        const r = getSettlementResolver().resolve(evidence);
        const state = r?.state || 'UNKNOWN';
        return {
          executed: true,
          action,
          disposition: `Settlement interpretation: ${state}. ` +
            (state === 'DEFINITELY_PAID'
              ? 'Money moved. Do not pay again.'
              : state === 'DEFINITELY_NOT_PAID'
                ? 'No value moved for this operation. A fresh attempt is safe.'
                : state === 'AUTHORIZED_NOT_SETTLED'
                  ? 'Authorization exists but no settlement attempt recorded.'
                  : state === 'SETTLEMENT_PENDING'
                    ? 'A settlement transaction exists but is not yet confirmed. Watch it; do not re-pay.'
                    : state === 'CONFLICT'
                      ? 'Evidence sources disagree. Human judgment required before any action.'
                      : 'Insufficient evidence. Fail closed: do not retry, do not repay.'),
          result: r,
        };
      }
      case 'failure_classification': {
        const c = getClassifier().classifyFailureV2(evidence);
        return {
          executed: true,
          action,
          disposition: `Failure class: ${c?.class || c?.code || 'unknown'}.`,
          result: c,
        };
      }
      case 'preflight': {
        const rep = getPreflight().runMcpPreflight(evidence);
        return {
          executed: true,
          action,
          disposition: 'Preflight checks complete.',
          result: rep,
        };
      }
      case 'duplicate_payment_risk': {
        const r = getSettlementResolver().resolve(evidence);
        const txHash = (evidence as any)?.txHash || null;
        const risk =
          r?.state === 'DEFINITELY_PAID'
            ? 'HIGH: a confirmed settlement already exists for this operation. A retry would double-spend.'
            : r?.state === 'UNKNOWN'
              ? 'UNKNOWN: cannot assess. Fail closed — do not retry until settlement state is resolved.'
              : 'LOW: no confirmed prior settlement in the supplied evidence.';
        return {
          executed: true,
          action,
          disposition: risk,
          result: { txHash, settlementState: r?.state || 'UNKNOWN', risk },
        };
      }
      case 'recover': {
        // Simplified server-side recovery decision: if the rail has already
        // authorized an invocation for the same txHash/operation, surface it;
        // otherwise return the settlement-based safe-retry guidance.
        const r = getSettlementResolver().resolve(evidence);
        const state = r?.state || 'UNKNOWN';
        const decision =
          state === 'DEFINITELY_PAID'
            ? 'RECOVERABLE: prior settlement proven. Re-attach the existing receipt; never a fresh authorization.'
            : state === 'DEFINITELY_NOT_PAID'
              ? 'SAFE_RETRY: no value moved. One fresh attempt with a new nonce is safe.'
              : 'HUMAN_REVIEW: settlement state does not support an automated retry decision.';
        return {
          executed: true,
          action,
          disposition: decision,
          result: { decision, settlementState: state, detail: r },
        };
      }
      default:
        return {
          executed: false,
          action,
          error:
            `'use local runtime' — the '${action}' action requires a local callx402 runtime ` +
            `(CLI + v2.0.0 tree) or a Veyline subscription path. Server-side execution is not available for this action.`,
        };
    }
  } catch (err) {
    return {
      executed: false,
      action,
      error: err instanceof Error ? err.message : 'execution failed',
    };
  }
}

/** Actions with server-side execution available. */
export const SERVER_EXECUTABLE_ACTIONS = [
  'diagnose',
  'resolve',
  'settlement_interpretation',
  'failure_classification',
  'preflight',
  'duplicate_payment_risk',
  'recover',
];
