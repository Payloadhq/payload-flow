/**
 * Acceptance graph builders — the three §7 validation graphs, built from
 * blank graphs with generic primitives only (mirrors test/validations.test.ts).
 *
 * Payout destinations are overridable so real addresses/wallets plug in at
 * acceptance time: pass e.g. { producer: 'bank:acct-1234' }.
 * No defaults are real destinations; the built-ins are obvious placeholders.
 */
import type { GraphSpec } from '../sdk.js';
import type { Participant, Rule } from '../types.js';

type DestOverrides = Record<string, string>;

function participant(
  id: string,
  kind: Participant['kind'],
  roles: string[],
  destRail: Participant['payoutDestinations'][number]['rail'],
  address: string,
  overrides?: DestOverrides,
): Participant {
  return {
    id,
    kind,
    roles,
    payoutDestinations: [{ rail: destRail, address: overrides?.[id] ?? address }],
  };
}

/** Validation A — creative economics (CSV / ROYALTY_RECEIVED). */
export function graphASpec(overrides?: DestOverrides): GraphSpec {
  return {
    id: 'graph-a',
    projectId: 'proj-a',
    ownerId: 'artist',
    participants: [
      participant('producer', 'person', ['contributor'], 'ach', 'bank:PLACEHOLDER-producer', overrides),
      participant('artist', 'person', ['owner'], 'stripe', 'bank:PLACEHOLDER-artist', overrides),
      participant('marketer', 'company', ['contributor'], 'ach', 'bank:PLACEHOLDER-marketer', overrides),
    ],
    revenueSources: [{ id: 'rs-a', kind: 'csv', config: {}, eventTypes: ['ROYALTY_RECEIVED'] }],
    rules: [
      {
        id: 'r-marketing',
        type: 'time_limited',
        priority: 10,
        params: {
          inner: {
            id: 'r-marketing-inner',
            type: 'percentage',
            priority: 10,
            params: { rateBps: 400, subjectParticipantId: 'marketer' },
          },
          effectiveFrom: '2026-01-01T00:00:00Z',
          effectiveTo: '2027-01-01T00:00:00Z',
        },
      },
      {
        id: 'r-recoup',
        type: 'recoupment',
        priority: 20,
        params: {
          subjectParticipantId: 'producer',
          advanceMicros: 10_000_000_000,
          recoupRateBps: 2000,
          postRateBps: 500,
        },
      },
      { id: 'r-residual', type: 'remainder', priority: 100, params: { subjectParticipantId: 'artist' } },
    ] as Rule[],
  };
}

/** Validation B — SaaS/marketplace (Stripe / SALE_COMPLETED). */
export function graphBSpec(overrides?: DestOverrides): GraphSpec {
  return {
    id: 'graph-b',
    projectId: 'proj-b',
    ownerId: 'owner',
    participants: [
      participant('platform', 'company', ['platform'], 'ach', 'bank:PLACEHOLDER-platform', overrides),
      participant('affiliate', 'person', ['referrer'], 'stripe', 'bank:PLACEHOLDER-affiliate', overrides),
      participant('developer', 'person', ['contributor'], 'ach', 'bank:PLACEHOLDER-developer', overrides),
      participant('owner', 'person', ['owner'], 'stripe', 'bank:PLACEHOLDER-owner', overrides),
    ],
    revenueSources: [{ id: 'rs-b', kind: 'stripe', config: {}, eventTypes: ['SALE_COMPLETED'] }],
    rules: [
      { id: 'b-fee', type: 'payload_fee', priority: 0, params: { licenseTier: 'builder' } },
      { id: 'b-platform', type: 'platform_fee', priority: 10, params: { rateBps: 600, subjectParticipantId: 'platform' } },
      {
        id: 'b-referral',
        type: 'referral',
        priority: 20,
        params: { rateBps: 1000 },
        conditions: { requireAttribution: true },
      },
      { id: 'b-dev', type: 'percentage', priority: 30, params: { rateBps: 500, subjectParticipantId: 'developer' } },
      { id: 'b-owner', type: 'remainder', priority: 100, params: { subjectParticipantId: 'owner' } },
    ] as Rule[],
  };
}

/** Validation C — machine commerce (x402 / API_PAYMENT). */
export function graphCSpec(overrides?: DestOverrides): GraphSpec {
  return {
    id: 'graph-c',
    projectId: 'proj-c',
    ownerId: 'operator',
    participants: [
      participant('developer', 'person', ['contributor'], 'ach', 'bank:PLACEHOLDER-developer', overrides),
      participant('referring-agent', 'agent', ['referrer'], 'x402', '0xPLACEHOLDER-agent-wallet', overrides),
      participant('operator', 'company', ['owner'], 'ach', 'bank:PLACEHOLDER-operator', overrides),
    ],
    revenueSources: [{ id: 'rs-c', kind: 'x402', config: {}, eventTypes: ['API_PAYMENT'] }],
    rules: [
      { id: 'c-fee', type: 'payload_fee', priority: 0, params: { licenseTier: 'free' } },
      {
        id: 'c-peruse',
        type: 'per_use',
        priority: 10,
        params: { rateMicrosPerUnit: 2000, subjectParticipantId: 'developer' },
      },
      {
        id: 'c-referral',
        type: 'referral',
        priority: 20,
        params: { rateBps: 1000 },
        conditions: { requireAttribution: true },
      },
      { id: 'c-operator', type: 'remainder', priority: 100, params: { subjectParticipantId: 'operator' } },
    ] as Rule[],
  };
}

export const GRAPH_BUILDERS = { a: graphASpec, b: graphBSpec, c: graphCSpec } as const;
export type GraphKey = keyof typeof GRAPH_BUILDERS;
