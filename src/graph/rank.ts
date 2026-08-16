/**
 * File-level relatedness: the ranking the benchmark validated, in the layer the agent uses.
 *
 * This started life inside the benchmark, where a dozen strategies were scored against gold
 * patches. Only two of them survived that comparison — a degree-damped random walk over the
 * structural graph, and this repository's own co-change history — and `relatedFiles` is their
 * fusion. It lives here rather than under `bench/` because an offline result the agent cannot
 * reach is not an improvement to anything.
 *
 * The strategies that lost, and the harness that scores them, stay in `bench/rankers.ts`.
 */
import path from 'node:path';
import { coChangeNeighbours } from './cochange.js';
import { CONFIDENCE_FACTOR, PROPAGATION, type GraphEdge } from './model.js';
import type { GraphStore } from './store.js';

export interface FileGraph {
  /** u -> what u depends on. Following it answers "what does this code use?". */
  forward: Map<string, Map<string, number>>;
  /**
   * u -> what depends on u. Change propagates mostly along here: move a signature and the
   * callers break, not the callees. Keeping only an undirected view threw that away.
   */
  backward: Map<string, Map<string, number>>;
  /** Total degree per file, for damping hubs. */
  degree: Map<string, number>;
  /**
   * Package membership, stored as a lookup and a member list rather than as each file's own
   * copy of its mates.
   *
   * Materialising the mates per file is quadratic in the size of a directory, and it ran a
   * 978-instance sweep out of a 4GB heap on mui/material-ui. Widening the file list from
   * parsed files to every tracked file was what exposed it: directories that held a handful of
   * source files now hold hundreds of markdown and JSON files beside them, and a 2000-file
   * directory was allocating two thousand 2000-element arrays.
   */
  packageOf: Map<string, string>;
  packageMembers: Map<string, string[]>;
}

/**
 * Directories above this size are treated as buckets rather than modules.
 *
 * A Go package is a unit of encapsulation and is rarely more than a few dozen files. A
 * directory holding several hundred is a docs folder or a test corpus, where "shares a
 * directory" carries no information — and since only the first `limit` mates are ever used,
 * the signal there is whichever names the scan happened to reach first.
 */
const MAX_PACKAGE_SIZE = 200;

/** Package mates for one file, computed on demand and never stored per file. */
export function packageMatesOf(fileGraph: FileGraph, file: string, limit: number): string[] {
  const key = fileGraph.packageOf.get(file);
  if (key === undefined) return [];
  const members = fileGraph.packageMembers.get(key);
  if (!members || members.length > MAX_PACKAGE_SIZE) return [];

  const out: string[] = [];
  for (const mate of members) {
    if (mate === file) continue;
    out.push(mate);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Go's unit of encapsulation is the package, which is the directory: two files in one package
 * share a namespace and compile together, and co-change constantly whether or not either
 * calls the other. The file-level call graph cannot see that relationship at all, which is
 * why a plain directory heuristic beat it on Go repositories. Encoding the language's own
 * scoping rule is the fix — not adopting the heuristic.
 */

export function buildFileGraph(store: GraphStore): FileGraph {
  const forward = new Map<string, Map<string, number>>();
  const backward = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();

  const link = (into: Map<string, Map<string, number>>, from: string, to: string, w: number) => {
    let row = into.get(from);
    if (!row) into.set(from, (row = new Map()));
    row.set(to, Math.max(row.get(to) ?? 0, w));
  };

  for (const edge of store.edges.values() as Iterable<GraphEdge>) {
    const from = store.nodes.get(edge.from);
    const to = store.nodes.get(edge.to);
    if (!from || !to || from.file === to.file) continue;
    // Propagation strength, discounted by how sure we are the edge exists at all.
    const weight = PROPAGATION[edge.kind] * CONFIDENCE_FACTOR[edge.confidence];
    link(forward, from.file, to.file, weight);
    link(backward, to.file, from.file, weight);
  }

  for (const [file, row] of forward) degree.set(file, (degree.get(file) ?? 0) + row.size);
  for (const [file, row] of backward) degree.set(file, (degree.get(file) ?? 0) + row.size);

  const byPackage = new Map<string, string[]>();
  const push = (key: string, file: string) => {
    const bucket = byPackage.get(key);
    if (bucket) bucket.push(file);
    else byPackage.set(key, [file]);
  };
  for (const [file, facts] of store.facts) {
    // Go: `pkg` is the package clause, and a directory holds exactly one package.
    // Elsewhere a module is file-scoped, so the directory is a weaker grouping.
    const key = facts.lang === 'go' ? `${path.posix.dirname(file)}::${facts.pkg}` : path.posix.dirname(file);
    push(key, file);
  }
  // Files with no parser still belong to a package: `go.mod` sits with the module it declares,
  // `package.json` with the code it builds. They have no symbols and so can never appear in
  // the structural graph, which is exactly why they need some other route in.
  for (const file of store.knownFiles) {
    if (!store.facts.has(file)) push(path.posix.dirname(file), file);
  }

  const packageOf = new Map<string, string>();
  for (const [key, files] of byPackage) {
    for (const file of files) packageOf.set(file, key);
  }

  return { forward, backward, degree, packageOf, packageMembers: byPackage };
}

/**
 * Personalized PageRank, replacing breadth-first traversal.
 *
 * BFS was not ranking so much as ordering by hop, and code graphs are scale-free: from any
 * anchor the first hop reaches a hub, the second fans out to hundreds of files carrying
 * identical weights, and the tie-break that then decided the whole result was
 * `localeCompare` — filename alphabetical order, which is noise. That is the most likely
 * reason structural recall@5 (16.4%) trailed recall@20 (35.1%) so badly: the right files were
 * in the set and arbitrarily placed within it. A random walk with restart scores by how often
 * a walker starting at the anchor lands on a file, which is continuous, ties almost nothing,
 * and counts many weak paths as evidence where BFS counted only the shortest.
 *
 * Each step is damped by the destination's degree, so an edge into a file that everything
 * touches carries little. This is the structural counterpart of scoring history by lift rather
 * than by raw co-occurrence — normalising by how popular the destination is on its own. Doing
 * that for history and not for structure was an inconsistency, not a design choice.
 *
 * Implemented as a sparse push: mass decays by `1 - restart` each sweep, so it is bounded by
 * the frontier rather than by repository size, and the tail is truncated once the remaining
 * mass cannot change the ordering.
 */

export function personalizedPageRank(
  adjacency: Map<string, Map<string, number>>[],
  degree: Map<string, number>,
  anchor: string,
  { restart = 0.15, sweeps = 12, epsilon = 1e-6 } = {},
): Map<string, number> {
  const score = new Map<string, number>();
  let mass = new Map<string, number>([[anchor, 1]]);

  for (let sweep = 0; sweep < sweeps && mass.size; sweep++) {
    const next = new Map<string, number>();
    for (const [file, m] of mass) {
      // Weights are gathered across the directions this walk is allowed to use, so a file
      // reachable both ways is not counted twice at different strengths.
      const row = new Map<string, number>();
      for (const adj of adjacency) {
        for (const [to, w] of adj.get(file) ?? []) {
          row.set(to, Math.max(row.get(to) ?? 0, w));
        }
      }
      if (!row.size) continue;

      let total = 0;
      const damped = new Map<string, number>();
      for (const [to, w] of row) {
        const d = w / Math.log1p(1 + (degree.get(to) ?? 0));
        damped.set(to, d);
        total += d;
      }
      if (total <= 0) continue;

      const share = (1 - restart) * m;
      for (const [to, d] of damped) {
        next.set(to, (next.get(to) ?? 0) + (share * d) / total);
      }
    }

    // Every visit counts toward the score, but only walkers still carrying meaningful mass go
    // on. Without this the frontier reaches the whole repository after a few sweeps and the
    // cost becomes proportional to repository size for contributions far below the gap between
    // adjacent scores. Truncating the tail bounds the walk instead.
    mass = new Map();
    for (const [file, m] of next) {
      score.set(file, (score.get(file) ?? 0) + m);
      if (m >= epsilon) mass.set(file, m);
    }
  }

  score.delete(anchor);
  return score;
}

function byScore(score: Map<string, number>, limit: number): string[] {
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file]) => file);
}

export function graphRankedPPR(fileGraph: FileGraph, anchor: string, limit: number): string[] {
  const score = personalizedPageRank(
    [fileGraph.forward, fileGraph.backward],
    fileGraph.degree,
    anchor,
  );
  return byScore(score, limit);
}

/**
 * Dependents only: files that would break if the anchor's surface changed.
 *
 * Scored separately from the bidirectional walk because the two answer different questions,
 * and the aggregate cannot show whether direction carries information if direction is
 * averaged away before it is measured.
 */

export function coChangeRanked(store: GraphStore, anchor: string, limit: number): string[] {
  return coChangeNeighbours(store.coChange, anchor, limit).map((entry) => entry.file);
}

/**
 * Reciprocal rank fusion.
 *
 * The three signals produce scores on incomparable scales — hop counts, directory tiers,
 * co-occurrence lift — so blending the scores would mean inventing weights and tuning them
 * against the very benchmark that is supposed to judge the result. RRF combines *ranks*
 * instead, needs no per-signal calibration, and is hard to overfit: a file ranked highly by
 * two signals beats one ranked first by a single signal.
 */
export function fuse(rankings: string[][], limit: number, k0 = 60): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((file, index) => {
      score.set(file, (score.get(file) ?? 0) + 1 / (k0 + index + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file]) => file);
}

/**
 * The two signals that beat every alternative and every larger combination.
 *
 * Locality and package membership were measured here too and removed: reciprocal rank fusion
 * gives each input an equal vote, so a weak ranking displaces a good one rather than merely
 * failing to help, and dropping them each raised recall. Structure and history are what is
 * left, and they are complementary — on the repositories where one is weakest the other is
 * strongest, which is why fusing them beats either alone by a wide margin.
 */
export function relatedFiles(
  store: GraphStore,
  fileGraph: FileGraph,
  anchor: string,
  limit: number,
): string[] {
  return fuse(
    [graphRankedPPR(fileGraph, anchor, limit), coChangeRanked(store, anchor, limit)],
    limit,
  );
}
