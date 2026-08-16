import { describe, expect, it } from 'vitest';
import {
  buildFileGraph,
  dependentsRanked,
  graphRankedBFS,
  graphRankedPPR,
  packageMatesOf,
  personalizedPageRank,
  type FileGraph,
} from '../src/bench/rankers.js';
import type { GraphStore } from '../src/graph/store.js';

/** A unit-weight file graph, with degrees derived from the edges rather than asserted. */
function graphOf(edges: [string, string][]): FileGraph {
  const forward = new Map<string, Map<string, number>>();
  const backward = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();

  const link = (into: Map<string, Map<string, number>>, from: string, to: string) => {
    let row = into.get(from);
    if (!row) into.set(from, (row = new Map()));
    row.set(to, 1);
  };
  for (const [from, to] of edges) {
    link(forward, from, to);
    link(backward, to, from);
  }
  for (const rows of [forward, backward]) {
    for (const [file, row] of rows) degree.set(file, (degree.get(file) ?? 0) + row.size);
  }
  return { forward, backward, degree, packageOf: new Map(), packageMembers: new Map() };
}

describe('structural ranking', () => {
  /**
   * The defect that motivated the walk. Both files sit one hop from the anchor with identical
   * weights, so breadth-first has nothing left to sort by and falls back to `localeCompare` —
   * filename order deciding the result. `z-multi` is reachable by two paths and `a-single` by
   * one, which is real evidence that alphabetical order discards.
   */
  it('ranks by accumulated evidence where breadth-first ranks alphabetically', () => {
    const graph = graphOf([
      ['anchor.ts', 'a-single.ts'],
      ['anchor.ts', 'via.ts'],
      ['anchor.ts', 'z-multi.ts'],
      ['via.ts', 'z-multi.ts'],
    ]);

    const walk = [...personalizedPageRank([graph.forward], graph.degree, 'anchor.ts')].sort(
      (a, b) => b[1] - a[1],
    );
    expect(walk[0][0]).toBe('z-multi.ts');

    // The old ranker put them in the opposite order, and only because of the filenames.
    const bfs = graphRankedBFS(graph, 'anchor.ts', 10);
    expect(bfs.indexOf('a-single.ts')).toBeLessThan(bfs.indexOf('z-multi.ts'));
  });

  /**
   * Hub suppression. Both neighbours are one unit-weight edge from the anchor, so the only
   * thing separating them is that everything else touches the hub too. Scoring history by lift
   * already discounts a file that co-occurs with everything; this is the same correction for
   * structure, which previously had none.
   */
  it('discounts an edge into a file that everything touches', () => {
    const edges: [string, string][] = [
      ['anchor.ts', 'a-hub.ts'],
      ['anchor.ts', 'z-quiet.ts'],
    ];
    for (let i = 0; i < 30; i++) edges.push(['a-hub.ts', `other-${i}.ts`]);

    const ranked = graphRankedPPR(graphOf(edges), 'anchor.ts', 5);
    expect(ranked.indexOf('z-quiet.ts')).toBeLessThan(ranked.indexOf('a-hub.ts'));
  });

  /**
   * Direction carries information, and averaging it away before measuring hides that. A file
   * the anchor calls need not change when the anchor does; a file that calls the anchor breaks
   * when its signature moves.
   */
  it('separates what depends on the anchor from what the anchor depends on', () => {
    const graph = graphOf([
      ['anchor.ts', 'callee.ts'],
      ['caller.ts', 'anchor.ts'],
    ]);

    expect(dependentsRanked(graph, 'anchor.ts', 10)).toEqual(['caller.ts']);
    expect(graphRankedPPR(graph, 'anchor.ts', 10).sort()).toEqual(['callee.ts', 'caller.ts']);
  });

  it('never returns the anchor, however many paths lead back to it', () => {
    const graph = graphOf([
      ['anchor.ts', 'a.ts'],
      ['a.ts', 'anchor.ts'],
      ['a.ts', 'b.ts'],
      ['b.ts', 'anchor.ts'],
    ]);
    expect(graphRankedPPR(graph, 'anchor.ts', 10)).not.toContain('anchor.ts');
  });

  /**
   * The allocation that ended a 978-instance sweep inside a 4GB heap. Storing each file's own
   * copy of its package mates is quadratic in directory size, and widening the file list from
   * parsed files to every tracked file is what made directories large enough for it to matter.
   * One array per directory, not one per file.
   */
  it('stores package membership once per directory, not once per file', () => {
    const files = Array.from({ length: 3000 }, (_, i) => `docs/page-${i}.md`);
    const store = {
      edges: new Map(),
      nodes: new Map(),
      facts: new Map(),
      knownFiles: new Set(files),
    } as unknown as GraphStore;

    const graph = buildFileGraph(store);
    expect(graph.packageMembers.size).toBe(1);
    expect([...graph.packageMembers.values()][0]).toHaveLength(3000);

    // And a directory that large is a bucket, not a module: sharing it says nothing, and only
    // the first few members would ever be used anyway.
    expect(packageMatesOf(graph, files[0], 20)).toEqual([]);
  });

  it('returns package mates, excluding the file itself, up to the limit', () => {
    const files = ['svc/a.go', 'svc/b.go', 'svc/c.go'];
    const store = {
      edges: new Map(),
      nodes: new Map(),
      facts: new Map(),
      knownFiles: new Set(files),
    } as unknown as GraphStore;

    const graph = buildFileGraph(store);
    expect(packageMatesOf(graph, 'svc/a.go', 10).sort()).toEqual(['svc/b.go', 'svc/c.go']);
    expect(packageMatesOf(graph, 'svc/a.go', 1)).toHaveLength(1);
    expect(packageMatesOf(graph, 'nowhere/x.go', 10)).toEqual([]);
  });

  it('returns nothing for a file with no structural edges', () => {
    expect(graphRankedPPR(graphOf([['a.ts', 'b.ts']]), 'orphan.ts', 10)).toEqual([]);
  });
});
