/**
 * The candidate retrieval strategies, scored side by side in one run.
 *
 * The first evaluation compared exactly two things and reported a mean, which turned out to
 * hide the interesting result: the graph beat the directory baseline decisively on svelte and
 * lost decisively on go-zero. A single number could not say that, and could not say whether
 * the two signals were substitutes or complements. So every strategy is computed for every
 * anchor, from the same store, and reported together.
 */
import path from 'node:path';
import { coChangeNeighbours } from '../graph/cochange.js';
import { CONFIDENCE_RANK, type GraphEdge } from '../graph/model.js';
import type { GraphStore } from '../graph/store.js';

export type Strategy = 'graph' | 'directory' | 'cochange' | 'combined';
export const STRATEGIES: Strategy[] = ['graph', 'directory', 'cochange', 'combined'];

/** File-level adjacency derived from symbol-level edges, plus package membership. */
export interface FileGraph {
  structural: Map<string, Map<string, number>>;
  /** Files sharing a package (Go) or a directory (everything else). */
  packageMates: Map<string, string[]>;
}

/**
 * Go's unit of encapsulation is the package, which is the directory: two files in one package
 * share a namespace and compile together, and co-change constantly whether or not either
 * calls the other. The file-level call graph cannot see that relationship at all, which is
 * why a plain directory heuristic beat it on Go repositories. Encoding the language's own
 * scoping rule is the fix — not adopting the heuristic.
 */
export function buildFileGraph(store: GraphStore): FileGraph {
  const structural = new Map<string, Map<string, number>>();
  const link = (from: string, to: string, weight: number) => {
    if (from === to) return;
    let row = structural.get(from);
    if (!row) structural.set(from, (row = new Map()));
    row.set(to, Math.max(row.get(to) ?? 0, weight));
  };

  for (const edge of store.edges.values() as Iterable<GraphEdge>) {
    const from = store.nodes.get(edge.from);
    const to = store.nodes.get(edge.to);
    if (!from || !to) continue;
    const weight = CONFIDENCE_RANK[edge.confidence];
    // Undirected: a caller and a callee are equally likely to co-change.
    link(from.file, to.file, weight);
    link(to.file, from.file, weight);
  }

  const byPackage = new Map<string, string[]>();
  for (const [file, facts] of store.facts) {
    // Go: `pkg` is the package clause, and a directory holds exactly one package.
    // Elsewhere a module is file-scoped, so the directory is a weaker grouping.
    const key = facts.lang === 'go' ? `${path.posix.dirname(file)}::${facts.pkg}` : path.posix.dirname(file);
    const bucket = byPackage.get(key);
    if (bucket) bucket.push(file);
    else byPackage.set(key, [file]);
  }

  const packageMates = new Map<string, string[]>();
  for (const files of byPackage.values()) {
    for (const file of files) packageMates.set(file, files.filter((f) => f !== file));
  }

  return { structural, packageMates };
}

/** Breadth-first over structural edges, nearest and most-confident first. */
export function graphRanked(fileGraph: FileGraph, anchor: string, limit: number): string[] {
  const seen = new Set<string>([anchor]);
  const out: string[] = [];
  let frontier: string[] = [anchor];

  for (let hop = 0; hop < 3 && out.length < limit; hop++) {
    const next: { file: string; weight: number }[] = [];
    for (const file of frontier) {
      for (const [neighbour, weight] of fileGraph.structural.get(file) ?? []) {
        if (!seen.has(neighbour)) next.push({ file: neighbour, weight });
      }
    }
    next.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

    frontier = [];
    for (const { file } of next) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
      frontier.push(file);
      if (out.length >= limit) break;
    }
    if (!frontier.length) break;
  }
  return out;
}

/** Everything reachable, unranked and unbounded — the soundness question. */
export function graphClosure(fileGraph: FileGraph, anchor: string, maxHops = 5): Set<string> {
  const seen = new Set<string>([anchor]);
  let frontier = [anchor];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const neighbour of fileGraph.structural.get(file)?.keys() ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  seen.delete(anchor);
  return seen;
}

/** The null hypothesis: files sitting near the anchor in the directory tree. */
export function directoryRanked(files: string[], anchor: string, limit: number): string[] {
  const anchorDir = path.posix.dirname(anchor);
  return files
    .filter((file) => file !== anchor)
    .map((file) => {
      const dir = path.posix.dirname(file);
      let score = 0;
      if (dir === anchorDir) score = 3;
      else if (dir.startsWith(`${anchorDir}/`) || anchorDir.startsWith(`${dir}/`)) score = 2;
      else if (path.posix.dirname(dir) === path.posix.dirname(anchorDir)) score = 1;
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => entry.file);
}

/** What this repository's own history changed alongside the anchor. */
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

export interface RankContext {
  store: GraphStore;
  fileGraph: FileGraph;
  allFiles: string[];
}

export function rank(strategy: Strategy, ctx: RankContext, anchor: string, limit: number): string[] {
  switch (strategy) {
    case 'graph':
      return graphRanked(ctx.fileGraph, anchor, limit);
    case 'directory':
      return directoryRanked(ctx.allFiles, anchor, limit);
    case 'cochange':
      return coChangeRanked(ctx.store, anchor, limit);
    case 'combined':
      // Package mates are folded in as their own ranking: on Go they are the signal the call
      // graph structurally cannot see.
      return fuse(
        [
          graphRanked(ctx.fileGraph, anchor, limit),
          (ctx.fileGraph.packageMates.get(anchor) ?? []).slice(0, limit),
          coChangeRanked(ctx.store, anchor, limit),
          directoryRanked(ctx.allFiles, anchor, limit),
        ],
        limit,
      );
  }
}
