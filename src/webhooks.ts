/**
 * Payload Flow MVP — webhooks-out (in-memory emitter).
 *
 * emit() validates the event type against the contract's WebhookEventType
 * union, stamps `at` with the current time (ISO 8601), and appends.
 * emitted() returns a copy so callers cannot mutate the emitter's log.
 */

import type { WebhookEmitter, WebhookEvent, WebhookEventType } from './types.js';

const KNOWN_TYPES: ReadonlySet<WebhookEventType> = new Set([
  'entitlement.calculated',
  'payout.instructed',
  'payout.settled',
  'payout.failed',
  'rule.versioned',
]);

export class InMemoryWebhookEmitter implements WebhookEmitter {
  private events: WebhookEvent[] = [];

  emit(event: WebhookEvent): void {
    if (!KNOWN_TYPES.has(event.type)) {
      throw new Error(
        `unknown webhook event type: ${String((event as { type?: unknown }).type)}`,
      );
    }
    this.events.push({ ...event, at: new Date().toISOString() });
  }

  emitted(): WebhookEvent[] {
    return this.events.map((e) => ({ ...e }));
  }
}
