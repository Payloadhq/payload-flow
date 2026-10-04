/**
 * graph.test.ts — portability (exportGraph / importGraph) tests.
 *
 * The economic relationship must be able to leave Flow: export produces
 * canonical, self-describing JSON carrying the full version history; import
 * revalidates everything and refuses malformed or invalid graphs.
 */
import { describe, expect, it } from 'vitest';
import { exportGraph, importGraph } from '../src/graph.js';
import type { Participant, RevenueGraph, Rule } from '../src/types.js';

function participant(id: string): Participant {
  return { id, kind: 'person', roles: ['owner'], payoutDestinations: [{ rail: 'stripe', address: `addr_${id}` }] };
}

const remainder = (id: string, priority: number, subject: string): Rule => ({
  id,
  type: 'remainder',
  priority,
  params: { subjectParticipantId: subject },
});

function makeGraph(): RevenueGraph {
  return {
    id: 'g-port',
    projectId: 'p1',
    version: 2,
    status: 'active',
    participants: [participant('owner'), participant('licensor')],
    revenueSources: [{ id: 's1', kind: 'stripe', config: {}, eventTypes: ['SALE_COMPLETED'] }],
    rules: [
      {
        id: 'royalty',
        type: 'percentage',
        priority: 1,
        params: { rateBps: 1000, subjectParticipantId: 'licensor' },
        conditions: { derivedFrom: ['asset:track-042'] },
      },
      remainder('r', 99, 'owner'),
    ],
    versions: [
      {
        version: 1,
        rules: [remainder('r', 99, 'owner')],
        changedBy: 'owner',
        at: '2026-01-01T00:00:00.000Z',
        note: 'genesis',
      },
      {
        version: 2,
        rules: [],
        changedBy: 'owner',
        at: '2026-02-01T00:00:00.000Z',
        note: 'added downstream royalty',
      },
    ],
  };
}

describe('graph portability', () => {
  it('round-trips a graph through export and import with history intact', () => {
    const graph = makeGraph();
    const json = exportGraph(graph);
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.payloadFlowGraph).toBe(1);
    expect(parsed.graph.id).toBe('g-port');

    const back = importGraph(json);
    expect(back).toEqual({ ...graph });
    expect(back.versions).toHaveLength(2);
    expect(back.rules.find((r) => r.id === 'royalty')!.conditions!.derivedFrom).toEqual(['asset:track-042']);
  });

  it('export is deterministic (stable key order)', () => {
    const graph = makeGraph();
    const at = '2026-10-04T00:00:00.000Z';
    expect(exportGraph(graph, at)).toBe(exportGraph(graph, at));
  });

  it('import rejects non-JSON', () => {
    expect(() => importGraph('not json')).toThrow(/not valid JSON/);
  });

  it('import rejects unknown format versions', () => {
    expect(() => importGraph(JSON.stringify({ payloadFlowGraph: 99, graph: {} }))).toThrow(
      /unsupported export format version/,
    );
  });

  it('import rejects exports missing the graph payload', () => {
    expect(() => importGraph(JSON.stringify({ payloadFlowGraph: 1 }))).toThrow(/missing its graph payload/);
  });

  it('import rejects graphs with invalid rules', () => {
    const graph = makeGraph();
    // Two remainder rules: invalid.
    graph.rules = [remainder('r1', 98, 'owner'), remainder('r2', 99, 'owner')];
    const json = JSON.stringify({ payloadFlowGraph: 1, graph });
    expect(() => importGraph(json)).toThrow(/exactly one 'remainder' rule/);
  });

  it('export refuses an invalid graph', () => {
    const graph = makeGraph();
    graph.rules = [];
    expect(() => exportGraph(graph)).toThrow(/refusing to export/);
  });
});