/**
 * Payload Flow MVP — public surface.
 *
 * Exports the canonical types, the v1 adapters (stripe, x402, csv), the
 * developer SDK, and the host-constructed engine pieces (evaluation engine,
 * stores, ledger, fee engine, reconciliation, webhooks). The host
 * application constructs the engine pieces and passes them into the SDK as
 * EngineDeps.
 *
 * One deliberate non-export: graph.ts's proposeRuleChange/approveRuleChange
 * (mutating variants) are NOT re-exported here — the SDK's immutable-copy
 * variants (which delegate to them) are the public API. Import graph.js
 * directly if you need the mutating forms.
 */

export * from './types.js';
export * from './adapters/stripe.js';
export * from './adapters/x402.js';
export * from './adapters/csv.js';
export * from './sdk.js';

// Engine (host-constructed)
export { PayloadEvaluationEngine } from './engine.js';
export { InMemoryEventStore } from './event-store.js';
export { InMemoryStateStore } from './state-store.js';
export { InMemoryLedger, stableStringify } from './ledger.js';
export { createFeeEngine, InMemoryVolumeTracker } from './fee-engine.js';
export { createReconciler } from './reconciliation.js';
export { InMemoryWebhookEmitter } from './webhooks.js';

// Rules & events
export {
  validateGraph,
  expandWaterfall,
  expandRule,
  expandAllRules,
  coreRule,
} from './rules.js';
export { validateEvent, validateTouchEvent, EventValidationError } from './events.js';
export { exportGraph, importGraph } from './graph.js';
