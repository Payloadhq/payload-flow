/**
 * Payload Flow MVP — reconciliation (instructions vs partner settlement reports).
 *
 * The engine builds Distribution instructions (status 'proposed'); regulated
 * partners execute them and report back. This reconciler compares the two and
 * queues exceptions:
 *
 *   - no report line for an instruction            -> 'missing_settlement'
 *   - report line says 'failed'                     -> 'missing_settlement'
 *     (detail notes the partner-reported failure)
 *   - 'settled' line whose amount != instructed     -> 'amount_mismatch'
 *     (detail carries both amounts)
 *   - report line for an unknown instructionId      -> 'unexpected_settlement'
 *
 * Idempotent per instructionId: re-running reconcile() over the same data
 * never queues a duplicate exception. reconcile() returns only the
 * exceptions newly queued by that run; exceptions() returns everything
 * queued so far.
 */

import type {
  Distribution,
  Reconciler,
  ReconciliationException,
  SettlementReportLine,
} from './types.js';

export function createReconciler(): Reconciler {
  const queued = new Map<string, ReconciliationException>();

  function queue(ex: ReconciliationException): ReconciliationException | undefined {
    if (queued.has(ex.instructionId)) {
      return undefined;
    }
    queued.set(ex.instructionId, ex);
    return ex;
  }

  return {
    reconcile(
      distributions: Distribution[],
      report: SettlementReportLine[],
    ): ReconciliationException[] {
      const now = new Date().toISOString();
      const newlyQueued: ReconciliationException[] = [];

      const reportById = new Map<string, SettlementReportLine>();
      for (const line of report) {
        reportById.set(line.instructionId, line);
      }

      for (const d of distributions) {
        if (d.status !== 'proposed') {
          continue;
        }
        const line = reportById.get(d.instructionId);
        if (!line) {
          const ex = queue({
            instructionId: d.instructionId,
            kind: 'missing_settlement',
            detail: `no settlement report line for instruction ${d.instructionId}`,
            at: now,
          });
          if (ex) newlyQueued.push(ex);
          continue;
        }
        if (line.status === 'failed') {
          const ex = queue({
            instructionId: d.instructionId,
            kind: 'missing_settlement',
            detail: `partner reported failure for instruction ${d.instructionId}`,
            at: now,
          });
          if (ex) newlyQueued.push(ex);
          continue;
        }
        if (
          line.settledAmountMicros !== undefined &&
          line.settledAmountMicros !== d.amountMicros
        ) {
          const ex = queue({
            instructionId: d.instructionId,
            kind: 'amount_mismatch',
            detail:
              `settled amount ${line.settledAmountMicros} micros does not match ` +
              `instructed amount ${d.amountMicros} micros for instruction ${d.instructionId}`,
            at: now,
          });
          if (ex) newlyQueued.push(ex);
        }
      }

      const instructionIds = new Set(distributions.map((d) => d.instructionId));
      for (const line of report) {
        if (!instructionIds.has(line.instructionId)) {
          const ex = queue({
            instructionId: line.instructionId,
            kind: 'unexpected_settlement',
            detail: `settlement report line for unknown instruction ${line.instructionId}`,
            at: now,
          });
          if (ex) newlyQueued.push(ex);
        }
      }

      return newlyQueued;
    },

    exceptions(): ReconciliationException[] {
      return [...queued.values()];
    },
  };
}
