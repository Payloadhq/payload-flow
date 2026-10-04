/**
 * Webhooks-out tests — emit ordering, copy semantics, unknown-type rejection.
 */

import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../src/types.js';
import { InMemoryWebhookEmitter } from '../src/webhooks.js';

function event(type: WebhookEvent['type'], graphId = 'g1'): WebhookEvent {
  return { type, at: '1970-01-01T00:00:00.000Z', graphId, payload: {} };
}

describe('webhook emitter', () => {
  it('emits in order and stamps at with the current time', () => {
    const emitter = new InMemoryWebhookEmitter();
    emitter.emit(event('entitlement.calculated'));
    emitter.emit(event('payout.instructed'));
    const emitted = emitter.emitted();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.type).toBe('entitlement.calculated');
    expect(emitted[1]!.type).toBe('payout.instructed');
    for (const e of emitted) {
      expect(typeof e.at).toBe('string');
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      // The emitter stamps its own `at`; the caller's placeholder is replaced.
      expect(e.at).not.toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('emitted() returns a copy; mutating it does not affect the log', () => {
    const emitter = new InMemoryWebhookEmitter();
    emitter.emit(event('payout.settled'));
    const snapshot = emitter.emitted();
    snapshot[0]!.graphId = 'tampered';
    snapshot.pop();
    expect(emitter.emitted()).toHaveLength(1);
    expect(emitter.emitted()[0]!.graphId).toBe('g1');
  });

  it('unknown event type throws', () => {
    const emitter = new InMemoryWebhookEmitter();
    expect(() =>
      emitter.emit({ type: 'nonsense', at: '', graphId: 'g1', payload: {} } as WebhookEvent),
    ).toThrow(/unknown webhook event type/);
    expect(emitter.emitted()).toHaveLength(0);
  });
});
