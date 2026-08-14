/**
 * Change-surface recall: graph quality measured without spending a single model call.
 *
 * Every gate in this project is otherwise "run the agent and see", which is slow, expensive,
 * and entangles graph quality with model behaviour. But the benchmark ships an answer key:
 * `fix_patch` names exactly the files a correct change touches. So we can ask the graph
 * directly - given one file from that set as a foothold, how much of the rest does it
 * surface? - and iterate on resolution quality in seconds instead of dollars.
 *
 * A ranking metric without a baseline means nothing, so every run also scores the null
 * hypothesis: "just look at the other files in the same directory". The graph has to beat it.
 */
import { CONFIDENCE_RANK, type GraphEdge } from '../graph/model.js';
import { indexRepo } from '../graph/indexer.js';
import type { GraphStore } from '../graph/store.js';
import { changedFiles } from './patch.js';
import { instanceId, type BenchInstance } from './dataset.js';
import { prepareWorkspace } from './workspace.js';
import path from 'node:path';

export type Strategy = 'graph' | 'directory';

export const DEFAULT_K = [5, 10, 20];

/**
 * File-level adjacency derived from symbol-level edges. Two files are neighbours if any
 * symbol in one references any symbol in the other.
 */
function fileAdjacency(store: GraphStore): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();
  const link = (from: string, to: string, weight: number) => {
    if (from === to) return;
    let row = adjacency.get(from);
    if (!row) adjacency.set(from, (row = new Map()));
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
  return adjacency;
}

/** Breadth-first over the file graph, nearest and most-confident first. */
function graphRanked(adjacency: Map<string, Map<string, number>>, anchor: string, limit: number): string[] {
  const seen = new Set<string>([anchor]);
  const out: string[] = [];
  let frontier: string[] = [anchor];

  for (let hop = 0; hop < 3 && out.length < limit; hop++) {
    const next: { file: string; weight: number }[] = [];
    for (const file of frontier) {
      for (const [neighbour, weight] of adjacency.get(file) ?? []) {
        if (seen.has(neighbour)) continue;
        next.push({ file: neighbour, weight });
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

/** The null hypothesis: files sitting next to the anchor in the directory tree. */
function directoryRanked(files: string[], anchor: string, limit: number): string[] {
  const anchorDir = path.posix.dirname(anchor);
  const scored = files
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
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((entry) => entry.file);
}

export interface InstanceEval {
  instanceId: string;
  /** Files named by the gold patch. */
  goldFiles: string[];
  /** Gold files the graph could possibly surface: present at base commit, in a known language. */
  indexableGold: string[];
  anchors: number;
  recall: Record<number, number>;
  precision: Record<number, number>;
  baselineRecall: Record<number, number>;
  skipped?: string;
}

export interface EvalOptions {
  workdir: string;
  k?: number[];
  /** Cap on files ranked per anchor. */
  limit?: number;
}

/**
 * Leave-one-out over the gold file set: each gold file in turn plays the foothold the agent
 * found, and we measure how much of the remaining change surface the graph reaches.
 */
export async function evaluateInstance(
  instance: BenchInstance,
  options: EvalOptions,
): Promise<InstanceEval> {
  const id = instanceId(instance);
  const ks = options.k ?? DEFAULT_K;
  const limit = options.limit ?? Math.max(...ks);
  const gold = changedFiles(instance.fix_patch ?? '');

  const empty = () => Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>;
  const base: InstanceEval = {
    instanceId: id,
    goldFiles: gold,
    indexableGold: [],
    anchors: 0,
    recall: empty(),
    precision: empty(),
    baselineRecall: empty(),
  };

  if (gold.length < 2) {
    return { ...base, skipped: 'gold patch touches fewer than two files' };
  }

  const workspace = await prepareWorkspace(instance, { workdir: options.workdir });
  const store = await indexRepo(workspace.root);
  const indexed = new Set(store.files());
  const indexableGold = gold.filter((file) => indexed.has(file));

  if (indexableGold.length < 2) {
    return {
      ...base,
      indexableGold,
      skipped: `only ${indexableGold.length} gold file(s) are indexable (new files or unsupported language)`,
    };
  }

  const adjacency = fileAdjacency(store);
  const allFiles = store.files();

  const recall = empty();
  const precision = empty();
  const baselineRecall = empty();

  for (const anchor of indexableGold) {
    const targets = new Set(indexableGold.filter((file) => file !== anchor));
    const ranked = graphRanked(adjacency, anchor, limit);
    const baseline = directoryRanked(allFiles, anchor, limit);

    for (const k of ks) {
      const top = ranked.slice(0, k);
      const hits = top.filter((file) => targets.has(file)).length;
      recall[k] += hits / targets.size;
      precision[k] += top.length ? hits / top.length : 0;

      const baseTop = baseline.slice(0, k);
      baselineRecall[k] += baseTop.filter((file) => targets.has(file)).length / targets.size;
    }
  }

  const anchors = indexableGold.length;
  for (const k of ks) {
    recall[k] /= anchors;
    precision[k] /= anchors;
    baselineRecall[k] /= anchors;
  }

  return { ...base, indexableGold, anchors, recall, precision, baselineRecall };
}

export interface EvalSummary {
  instances: number;
  scored: number;
  skipped: number;
  k: number[];
  recall: Record<number, number>;
  precision: Record<number, number>;
  baselineRecall: Record<number, number>;
  perInstance: InstanceEval[];
}

export function summarise(results: InstanceEval[], ks: number[] = DEFAULT_K): EvalSummary {
  const scored = results.filter((r) => !r.skipped);
  const mean = (pick: (r: InstanceEval) => Record<number, number>) =>
    Object.fromEntries(
      ks.map((k) => [k, scored.length ? scored.reduce((sum, r) => sum + pick(r)[k], 0) / scored.length : 0]),
    ) as Record<number, number>;

  return {
    instances: results.length,
    scored: scored.length,
    skipped: results.length - scored.length,
    k: ks,
    recall: mean((r) => r.recall),
    precision: mean((r) => r.precision),
    baselineRecall: mean((r) => r.baselineRecall),
    perInstance: results,
  };
}

export function renderEvalSummary(summary: EvalSummary): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(`Change-surface recall over ${summary.scored} scored instance(s)`);
  lines.push(`(${summary.skipped} skipped: single-file patches or unindexable gold files)`);
  lines.push('');
  lines.push('  k   graph recall   precision   directory baseline   lift');
  for (const k of summary.k) {
    const graph = summary.recall[k];
    const baseline = summary.baselineRecall[k];
    const lift = baseline === 0 ? (graph > 0 ? Infinity : 0) : (graph - baseline) / baseline;
    const liftText = Number.isFinite(lift) ? `${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(0)}%` : '∞';
    lines.push(
      `  ${String(k).padStart(2)}   ${pct(graph).padStart(12)}   ${pct(summary.precision[k]).padStart(9)}   ${pct(baseline).padStart(18)}   ${liftText.padStart(6)}`,
    );
  }
  lines.push('');
  lines.push('Recall is what fraction of the rest of the gold patch the graph surfaces from one');
  lines.push('gold file. The graph has to beat the directory baseline to be worth its cost.');
  return lines.join('\n');
}
