/**
 * Change-surface recall: graph quality measured without spending a single model call.
 *
 * The benchmark ships an answer key — `fix_patch` names exactly the files a correct change
 * touches — so retrieval quality can be measured directly, in seconds, for free.
 *
 * Three lessons from the first full run are built into this version. Every strategy is scored
 * side by side, because the interesting result was that they fail differently by language and
 * a single mean hid it. Results are reported scale-free and stratified, because recall@20 is
 * capped at 20/(|G|-1) and large patches were being scored against an impossible bar. And
 * unindexable gold files are classified rather than lumped together, because "the patch
 * created this file" and "we silently failed to index it" are opposite facts.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { indexRepo } from '../graph/indexer.js';
import { changedFiles } from './patch.js';
import { instanceId, type BenchInstance } from './dataset.js';
import { prepareWorkspace } from './workspace.js';
import { buildFileGraph, graphClosure, rankAll, STRATEGIES, type Strategy } from './rankers.js';

export const DEFAULT_K = [5, 10, 20];

/**
 * Why a gold file is absent from the repository's file list. Only the last two are our problem.
 *
 * `no-adapter` and `parse-error` used to appear here, when the answer key was restricted to
 * parseable files. They are no longer misses: an unparsed file is still a tracked file, still
 * a legitimate target, and still reachable by history or locality — it simply has no symbols.
 */
export type MissReason = 'created-by-patch' | 'excluded-by-lister' | 'too-large';

export interface InstanceEval {
  instanceId: string;
  goldFiles: string[];
  indexableGold: string[];
  /** Why each gold file we could not use was missing. */
  misses: Record<string, MissReason>;
  anchors: number;
  /** recall@k and precision@k per strategy. */
  recall: Record<Strategy, Record<number, number>>;
  precision: Record<Strategy, Record<number, number>>;
  /** Scale-free: recall at k = |targets|, so a 90-file patch is not judged at k=20. */
  recallAtG: Record<Strategy, number>;
  /** Does the structural closure contain the targets at all, ignoring rank? */
  closureRecall: number;
  /** Closure size as a fraction of the repository - a closure of everything proves nothing. */
  closureShare: number;
  /** Fraction of gold files with no symbols, which structure can never reach. */
  unparsedShare: number;
  skipped?: string;
}

export interface EvalOptions {
  workdir: string;
  k?: number[];
  limit?: number;
  /** Re-use an existing workspace instead of re-cloning it. */
  reuse?: boolean;
}

/** Distinguishes a file the patch creates from one the lister should have returned. */
function classifyMiss(root: string, file: string): MissReason {
  let size: number | undefined;
  try {
    const info = statSync(path.join(root, file));
    size = info.isFile() ? info.size : undefined;
  } catch {
    return 'created-by-patch';
  }
  if (size === undefined) return 'created-by-patch';
  if (size > 1_500_000) return 'too-large';
  return 'excluded-by-lister';
}

function zeroPerStrategy<T>(make: () => T): Record<Strategy, T> {
  return Object.fromEntries(STRATEGIES.map((s) => [s, make()])) as Record<Strategy, T>;
}

export async function evaluateInstance(
  instance: BenchInstance,
  options: EvalOptions,
): Promise<InstanceEval> {
  const id = instanceId(instance);
  const ks = options.k ?? DEFAULT_K;
  const limit = options.limit ?? Math.max(...ks);
  const gold = changedFiles(instance.fix_patch ?? '');

  const emptyK = () => Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>;
  const base: InstanceEval = {
    instanceId: id,
    goldFiles: gold,
    indexableGold: [],
    misses: {},
    anchors: 0,
    recall: zeroPerStrategy(emptyK),
    precision: zeroPerStrategy(emptyK),
    recallAtG: zeroPerStrategy(() => 0),
    closureRecall: 0,
    closureShare: 0,
    unparsedShare: 0,
  };

  if (gold.length < 2) {
    return { ...base, skipped: 'gold patch touches fewer than two files' };
  }

  const workspace = await prepareWorkspace(instance, {
    workdir: options.workdir,
    fresh: !options.reuse,
  });
  const store = await indexRepo(workspace.root);
  // Every tracked file, not every parseable one.
  //
  // Scoring against parsed files only was measuring the wrong thing. A third of all gold files
  // the graph could not reach were `.json`, another sixth `.md`, plus `go.mod`, `go.sum` and
  // the `.d.ts` files that carry a library's public API — and none of them entered the answer
  // key at all. That silently redefined "the change surface" as "the part of the change
  // surface a parser understands", which is precisely the part structure was always going to
  // do best on. These files have no symbols and so can never appear in the structural graph;
  // they are reachable only by history or by locality, so excluding them subtracted most of
  // what co-change was added to find.
  const indexed = store.knownFiles;
  const indexableGold = gold.filter((file) => indexed.has(file));

  const misses: Record<string, MissReason> = {};
  for (const file of gold) {
    if (!indexed.has(file)) misses[file] = classifyMiss(workspace.root, file);
  }

  if (indexableGold.length < 2) {
    return {
      ...base,
      indexableGold,
      misses,
      skipped: `only ${indexableGold.length} gold file(s) are indexable`,
    };
  }

  const fileGraph = buildFileGraph(store);
  const allFiles = [...store.knownFiles];
  const ctx = { store, fileGraph, allFiles };

  // The share of targets with no symbols at all. This is a hard ceiling on the structural
  // strategy — not a defect in it — and reporting recall without it invites reading the
  // graph's shortfall as a modelling failure when part of it is arithmetic.
  const unparsed = indexableGold.filter((file) => !store.facts.has(file)).length;

  const recall = zeroPerStrategy(emptyK);
  const precision = zeroPerStrategy(emptyK);
  const recallAtG = zeroPerStrategy(() => 0);
  let closureRecall = 0;
  let closureShare = 0;

  for (const anchor of indexableGold) {
    const targets = new Set(indexableGold.filter((file) => file !== anchor));

    const closure = graphClosure(fileGraph, anchor);
    closureRecall += [...targets].filter((f) => closure.has(f)).length / targets.size;
    closureShare += closure.size / Math.max(1, allFiles.length);

    const ranked_ = rankAll(ctx, anchor, Math.max(limit, targets.size));
    for (const strategy of STRATEGIES) {
      const ranked = ranked_[strategy];
      for (const k of ks) {
        const top = ranked.slice(0, k);
        const hits = top.filter((file) => targets.has(file)).length;
        recall[strategy][k] += hits / targets.size;
        precision[strategy][k] += top.length ? hits / top.length : 0;
      }
      const atG = ranked.slice(0, targets.size);
      recallAtG[strategy] += atG.filter((file) => targets.has(file)).length / targets.size;
    }
  }

  const anchors = indexableGold.length;
  for (const strategy of STRATEGIES) {
    for (const k of ks) {
      recall[strategy][k] /= anchors;
      precision[strategy][k] /= anchors;
    }
    recallAtG[strategy] /= anchors;
  }

  return {
    ...base,
    indexableGold,
    misses,
    anchors,
    recall,
    precision,
    recallAtG,
    closureRecall: closureRecall / anchors,
    closureShare: closureShare / anchors,
    unparsedShare: unparsed / anchors,
  };
}

export interface EvalSummary {
  instances: number;
  scored: number;
  skipped: number;
  k: number[];
  recall: Record<Strategy, Record<number, number>>;
  precision: Record<Strategy, Record<number, number>>;
  recallAtG: Record<Strategy, number>;
  /** Instances where a strategy strictly beats the directory baseline at k = |targets|. */
  wins: Record<Strategy, number>;
  /** And where it strictly loses. The remainder are ties, usually both scoring zero. */
  losses: Record<Strategy, number>;
  closureRecall: number;
  closureShare: number;
  /** Share of gold files with no symbols — the ceiling on any structural strategy. */
  unparsedShare: number;
  missReasons: Record<string, number>;
  perInstance: InstanceEval[];
}

export function summarise(results: InstanceEval[], ks: number[] = DEFAULT_K): EvalSummary {
  const scored = results.filter((r) => !r.skipped);
  const n = Math.max(1, scored.length);

  const recall = zeroPerStrategy(() => Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>);
  const precision = zeroPerStrategy(() => Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>);
  const recallAtG = zeroPerStrategy(() => 0);
  const wins = zeroPerStrategy(() => 0);
  const losses = zeroPerStrategy(() => 0);

  for (const result of scored) {
    for (const strategy of STRATEGIES) {
      for (const k of ks) {
        recall[strategy][k] += result.recall[strategy][k] / n;
        precision[strategy][k] += result.precision[strategy][k] / n;
      }
      recallAtG[strategy] += result.recallAtG[strategy] / n;
      if (result.recallAtG[strategy] > result.recallAtG.directory) wins[strategy] += 1;
      else if (result.recallAtG[strategy] < result.recallAtG.directory) losses[strategy] += 1;
    }
  }

  const missReasons: Record<string, number> = {};
  for (const result of results) {
    for (const reason of Object.values(result.misses)) {
      missReasons[reason] = (missReasons[reason] ?? 0) + 1;
    }
  }

  return {
    instances: results.length,
    scored: scored.length,
    skipped: results.length - scored.length,
    k: ks,
    recall,
    precision,
    recallAtG,
    wins,
    losses,
    closureRecall: scored.reduce((sum, r) => sum + r.closureRecall, 0) / n,
    closureShare: scored.reduce((sum, r) => sum + r.closureShare, 0) / n,
    unparsedShare: scored.reduce((sum, r) => sum + r.unparsedShare, 0) / n,
    missReasons,
    perInstance: results,
  };
}

export function renderEvalSummary(summary: EvalSummary): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const n = summary.scored;

  lines.push(`Change-surface recall over ${n} scored instance(s) of ${summary.instances}`);
  lines.push('');
  lines.push(`  ${'strategy'.padEnd(13)}${summary.k.map((k) => `recall@${k}`.padStart(11)).join('')}${'recall@|G|'.padStart(12)}${'W/L vs dir'.padStart(13)}`);

  const row = (strategy: Strategy) => {
    const cols = summary.k.map((k) => pct(summary.recall[strategy][k]).padStart(11)).join('');
    const record =
      strategy === 'directory' ? '—' : `${summary.wins[strategy]}/${summary.losses[strategy]}`;
    lines.push(
      `  ${strategy.padEnd(13)}${cols}${pct(summary.recallAtG[strategy]).padStart(12)}${record.padStart(13)}`,
    );
  };

  for (const strategy of STRATEGIES) {
    if (strategy.startsWith('no-')) continue;
    row(strategy);
  }

  // The ablation. Read down this column, not across: how far the fusion falls when one signal
  // is removed is the only direct evidence that the signal contributes anything at all.
  lines.push('');
  lines.push('  Ablation — fusion with one signal removed:');
  for (const strategy of STRATEGIES) {
    if (!strategy.startsWith('no-')) continue;
    row(strategy);
    const drop = summary.recallAtG.combined - summary.recallAtG[strategy];
    const share = summary.recallAtG.combined ? drop / summary.recallAtG.combined : 0;
    const verdict =
      drop <= 0
        ? 'removing it does not hurt — the signal is carried by the others'
        : `${pct(share)} of the fused result depends on it`;
    lines.push(`  ${' '.repeat(13)}${verdict}`);
  }

  lines.push('');
  lines.push(`Soundness: the structural closure contains ${pct(summary.closureRecall)} of the target`);
  lines.push(`files, while spanning ${pct(summary.closureShare)} of the repository. A closure that`);
  lines.push('reaches everything proves nothing — read the two together.');
  lines.push('');
  lines.push(
    `${pct(summary.unparsedShare)} of gold files have no symbols at all — JSON, markdown, ` +
      `go.mod and\nthe like. Structure can never reach those, so that share is a ceiling on ` +
      `the graph\nstrategy rather than a shortfall in it.`,
  );

  if (Object.keys(summary.missReasons).length) {
    lines.push('');
    lines.push('Gold files not in the graph:');
    for (const [reason, count] of Object.entries(summary.missReasons).sort((a, b) => b[1] - a[1])) {
      const ours = reason !== 'created-by-patch';
      lines.push(`  ${reason.padEnd(20)} ${String(count).padStart(5)}${ours ? '   <- ours to fix' : ''}`);
    }
  }

  lines.push('');
  lines.push(
    `Population: instances whose gold patch touches at least two files the graph can parse. ` +
      `${summary.skipped} of ${summary.instances} were excluded, so these numbers describe ` +
      `multi-file source changes, not all changes.`,
  );
  return lines.join('\n');
}
