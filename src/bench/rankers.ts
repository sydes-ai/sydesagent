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
import {
  buildFileGraph,
  coChangeRanked,
  fuse,
  graphRankedPPR,
  packageMatesOf,
  personalizedPageRank,
  type FileGraph,
} from '../graph/rank.js';
import type { GraphStore } from '../graph/store.js';

// Re-exported so the evaluator and its tests keep one import site for the whole ranking surface.
export { buildFileGraph, coChangeRanked, fuse, graphRankedPPR, packageMatesOf, personalizedPageRank };
export type { FileGraph };

/**
 * The base signals, two fusions of them, and the fusion with each component removed.
 *
 * The leave-one-out variants answered the question they were added for and then raised a
 * better one. Removing the graph cost 11% of the fused result and removing history cost 14%,
 * so both earn their place. But removing locality, package membership, or the backward-only
 * walk each *improved* it — equal-vote fusion means a weak ranking displaces a good one rather
 * than merely failing to help. `lean` is the consequence: the two signals that survived.
 */
export type Strategy =
  | 'graph'
  | 'graph-bfs'
  | 'dependents'
  | 'directory'
  | 'cochange'
  | 'packages'
  | 'combined'
  | 'lean'
  | 'no-graph'
  | 'no-directory'
  | 'no-cochange'
  | 'no-packages';

/**
 * The components fused by `combined`.
 *
 * `dependents` — a backward-only walk — was measured here and removed. On its own it was the
 * weakest signal of the seven, and dropping it from the fusion *improved* the result, so it
 * was contributing rank noise rather than information. Direction still matters and is still
 * used: the bidirectional walk traverses both maps. What the measurement rejects is scoring
 * the backward direction as a separate opinion and giving it an equal vote.
 */
export const COMPONENTS = ['graph', 'packages', 'cochange', 'directory'] as const;
export type Component = (typeof COMPONENTS)[number];

/**
 * The two signals the ablation showed the fusion actually depends on.
 *
 * Reciprocal rank fusion gives every input an equal vote, so a weak ranking does not merely
 * fail to help — it displaces a good one. Removing locality and package membership each
 * *raised* recall, and they are near-duplicates of each other, so between them they were
 * casting two correlated votes for the weakest evidence available. This pairs the strongest
 * structural signal with the strongest historical one and nothing else.
 */
export const LEAN = ['graph', 'cochange'] as const;

export const STRATEGIES: Strategy[] = [
  'graph',
  'graph-bfs',
  'dependents',
  'directory',
  'cochange',
  'packages',
  'combined',
  'lean',
  'no-graph',
  'no-directory',
  'no-cochange',
  'no-packages',
];

/**
 * Dependents only: files that would break if the anchor's surface changed.
 *
 * Measured and rejected. On its own it was the weakest signal of the seven, and removing it
 * from the fusion improved the result — so it is kept as a scored row rather than as a
 * component. Direction is not what failed; the bidirectional walk uses both maps and beat the
 * old breadth-first ranker by half again. What failed is giving the backward direction its own
 * equal vote.
 */
export function dependentsRanked(fileGraph: FileGraph, anchor: string, limit: number): string[] {
  const score = personalizedPageRank([fileGraph.backward], fileGraph.degree, anchor);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file]) => file);
}

/**
 * The previous ranker: breadth-first, nearest and heaviest first.
 *
 * Retained and scored so that replacing it with a random walk is a measured claim rather than
 * an assumed improvement. If this row wins, the walk goes.
 */

export function graphRankedBFS(fileGraph: FileGraph, anchor: string, limit: number): string[] {
  const seen = new Set<string>([anchor]);
  const out: string[] = [];
  let frontier: string[] = [anchor];

  for (let hop = 0; hop < 3 && out.length < limit; hop++) {
    const next: { file: string; weight: number }[] = [];
    for (const file of frontier) {
      for (const adj of [fileGraph.forward, fileGraph.backward]) {
        for (const [neighbour, weight] of adj.get(file) ?? []) {
          if (!seen.has(neighbour)) next.push({ file: neighbour, weight });
        }
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
      for (const adj of [fileGraph.forward, fileGraph.backward]) {
        for (const neighbour of adj.get(file)?.keys() ?? []) {
          if (!seen.has(neighbour)) {
            seen.add(neighbour);
            next.push(neighbour);
          }
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

export interface RankContext {
  store: GraphStore;
  fileGraph: FileGraph;
  allFiles: string[];
}

/**
 * Every strategy for one anchor, with each base signal computed exactly once.
 *
 * Nine strategies over four signals would otherwise recompute the same rankings five times per
 * anchor, and `directoryRanked` alone is O(files in repo). Since the fusion variants are pure
 * functions of the base rankings, computing the components up front makes the ablation
 * essentially free rather than a multiple of the run it is auditing.
 */
export function rankAll(
  ctx: RankContext,
  anchor: string,
  limit: number,
): Record<Strategy, string[]> {
  const parts: Record<Component, string[]> = {
    graph: graphRankedPPR(ctx.fileGraph, anchor, limit),
    // On Go these are the signal the call graph structurally cannot see: one package is one
    // directory, so its files share a namespace whether or not either calls the other.
    packages: packageMatesOf(ctx.fileGraph, anchor, limit),
    cochange: coChangeRanked(ctx.store, anchor, limit),
    directory: directoryRanked(ctx.allFiles, anchor, limit),
  };

  const without = (dropped: Component) =>
    fuse(
      COMPONENTS.filter((c) => c !== dropped).map((c) => parts[c]),
      limit,
    );

  return {
    graph: parts.graph,
    'graph-bfs': graphRankedBFS(ctx.fileGraph, anchor, limit),
    dependents: dependentsRanked(ctx.fileGraph, anchor, limit),
    directory: parts.directory,
    cochange: parts.cochange,
    packages: parts.packages,
    combined: fuse(COMPONENTS.map((c) => parts[c]), limit),
    lean: fuse(LEAN.map((c) => parts[c]), limit),
    'no-graph': without('graph'),
    'no-directory': without('directory'),
    'no-cochange': without('cochange'),
    'no-packages': without('packages'),
  };
}

