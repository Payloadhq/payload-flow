/**
 * graph.ts — revenue-graph versioning and the material-change approval gate.
 *
 * Rule changes create new versions; history is immutable. A proposed change is
 * validated and stored as pendingChange — it does NOT activate. Activation
 * requires approveRuleChange with the project owner's id; only then do
 * version+1, versions[] append, and pendingChange clearance happen. Changes
 * apply to future events only (the engine always evaluates graph.rules at the
 * current version; past ledger entries keep their graphVersion).
 */
import { validateGraph } from './rules.js';
import { stableStringify } from './ledger.js';
import type { PendingChange, RevenueGraph, Rule } from './types.js';

export { validateGraph } from './rules.js';

function failProposed(errors: string[]): never {
  throw new Error(`proposed rule change is invalid:\n- ${errors.join('\n- ')}`);
}

/**
 * Validate proposed rules and stage them as a pending change. Does NOT
 * activate: graph.version and graph.rules are untouched.
 */
export function proposeRuleChange(
  graph: RevenueGraph,
  proposedBy: string,
  rules: Rule[],
  note?: string,
): RevenueGraph {
  const errors = validateGraph({ ...graph, rules });
  if (errors.length > 0) failProposed(errors);
  const pending: PendingChange = {
    proposedBy,
    at: new Date().toISOString(),
    rules,
  };
  if (note !== undefined) pending.note = note;
  graph.pendingChange = pending;
  return graph;
}

/**
 * Activate the pending change. Throws unless approverId === projectOwnerId.
 * Returns the new version number.
 */
export function approveRuleChange(
  graph: RevenueGraph,
  approverId: string,
  projectOwnerId: string,
): number {
  const pending = graph.pendingChange;
  if (!pending) {
    throw new Error(`approveRuleChange: graph '${graph.id}' has no pending rule change`);
  }
  if (approverId !== projectOwnerId) {
    throw new Error(
      `approveRuleChange: denied — approver '${approverId}' is not the project owner ('${projectOwnerId}')`,
    );
  }
  const errors = validateGraph({ ...graph, rules: pending.rules });
  if (errors.length > 0) failProposed(errors);
  const newVersion = graph.version + 1;
  graph.version = newVersion;
  graph.rules = pending.rules;
  const record = {
    version: newVersion,
    rules: pending.rules,
    changedBy: pending.proposedBy,
    approvedBy: approverId,
    at: new Date().toISOString(),
  };
  graph.versions.push(
    pending.note !== undefined ? { ...record, note: pending.note } : record,
  );
  delete graph.pendingChange;
  return newVersion;
}

/**
 * Portability: export a graph as canonical, self-describing JSON.
 * Key order is stable (stableStringify) so exports are deterministic and
 * diffable. The export carries the full version history — the agreement, not
 * just its current state — so the relationship can leave Flow without
 * losing its provenance. No processor or integration data is included.
 */
export function exportGraph(graph: RevenueGraph, at?: string): string {
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    throw new Error(`exportGraph: graph '${graph.id}' is invalid, refusing to export:\n- ${errors.join('\n- ')}`);
  }
  return stableStringify({
    payloadFlowGraph: 1, // export format version
    exportedAt: at ?? new Date().toISOString(),
    graph,
  });
}

/**
 * Portability: import a graph previously produced by exportGraph.
 * Parses, validates shape and rules, and returns the RevenueGraph.
 * Throws on anything malformed or invalid — never imports a broken agreement.
 */
export function importGraph(json: string): RevenueGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`importGraph: not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('importGraph: expected a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['payloadFlowGraph'] !== 1) {
    throw new Error(
      `importGraph: unsupported export format version '${String(record['payloadFlowGraph'])}' (expected 1)`,
    );
  }
  const graph = record['graph'];
  if (typeof graph !== 'object' || graph === null) {
    throw new Error('importGraph: export is missing its graph payload');
  }
  const g = graph as RevenueGraph;
  const gRecord = g as unknown as Record<string, unknown>;
  for (const field of ['id', 'projectId', 'version', 'status', 'participants', 'revenueSources', 'rules', 'versions']) {
    if (gRecord[field] === undefined) {
      throw new Error(`importGraph: graph is missing required field '${field}'`);
    }
  }
  if (!Array.isArray(g.participants) || !Array.isArray(g.revenueSources) || !Array.isArray(g.rules) || !Array.isArray(g.versions)) {
    throw new Error('importGraph: graph participants/revenueSources/rules/versions must be arrays');
  }
  const errors = validateGraph(g);
  if (errors.length > 0) {
    throw new Error(`importGraph: imported graph '${g.id}' is invalid:\n- ${errors.join('\n- ')}`);
  }
  return g;
}
