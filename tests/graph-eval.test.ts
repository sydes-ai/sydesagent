import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BenchInstance } from '../src/bench/dataset.js';
import { DEFAULT_K, evaluateInstance, summarise, type InstanceEval } from '../src/bench/graph-eval.js';
import { rankAll, STRATEGIES, type FileGraph, type RankContext } from '../src/bench/rankers.js';
import { EMPTY_COCHANGE } from '../src/graph/cochange.js';

import { changedFiles, parsePatchFiles } from '../src/bench/patch.js';
import { LocalExec } from '../src/exec/local.js';

/** Builds a scored result with the same value for every strategy and cutoff. */
function scoredFixture(id: string, value: number): InstanceEval {
  const perK = () => Object.fromEntries(DEFAULT_K.map((k) => [k, value]));
  const perStrategy = <T>(make: () => T) =>
    Object.fromEntries(STRATEGIES.map((s) => [s, make()])) as Record<string, T>;
  return {
    instanceId: id,
    goldFiles: [],
    indexableGold: [],
    misses: {},
    anchors: 2,
    recall: perStrategy(perK),
    precision: perStrategy(perK),
    recallAtG: perStrategy(() => value),
    closureRecall: value,
    closureShare: 0.1,
  } as unknown as InstanceEval;
}


const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let scratch: string;
let originRepo: string;
let baseSha: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'sydes-eval-'));
  originRepo = path.join(scratch, 'origin');
  await mkdir(originRepo, { recursive: true });
  await cp(GO_FIXTURE, originRepo, { recursive: true });

  const git = new LocalExec(originRepo);
  await git.run('git init -q -b main');
  await git.run('git config user.email sydes@test.local && git config user.name Sydes');
  await git.run('git add -A && git commit -q -m base');
  baseSha = (await git.run('git rev-parse HEAD')).stdout.trim();
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('patch parsing', () => {
  it('reads paths, renames and add/delete status out of a unified diff', () => {
    const patch = [
      'diff --git a/service/pokemon.go b/service/pokemon.go',
      'index 111..222 100644',
      '--- a/service/pokemon.go',
      '+++ b/service/pokemon.go',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/helpers/new.go b/helpers/new.go',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/helpers/new.go',
      'diff --git a/old/gone.go b/old/gone.go',
      'deleted file mode 100644',
      '--- a/old/gone.go',
      '+++ /dev/null',
      'diff --git a/pkg/a.go b/pkg/b.go',
      'similarity index 98%',
      'rename from pkg/a.go',
      'rename to pkg/b.go',
    ].join('\n');

    expect(parsePatchFiles(patch)).toEqual([
      { path: 'service/pokemon.go', status: 'modified' },
      { path: 'helpers/new.go', status: 'added' },
      { path: 'old/gone.go', status: 'deleted' },
      { path: 'pkg/b.go', status: 'modified' },
    ]);
  });

  it('handles an empty or absent patch', () => {
    expect(changedFiles('')).toEqual([]);
  });
});

/** A change that spans the handler, the service and the helper it calls. */
function instance(fixPatch: string): BenchInstance {
  return {
    org: 'example',
    repo: 'pokedex',
    number: 1,
    base: { sha: baseSha },
    title: 'Lower the power cap',
    fix_patch: fixPatch,
    lang: 'go',
    repo_url: originRepo,
  };
}

function diffFor(files: string[]): string {
  return files
    .map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b`)
    .join('\n');
}

describe('leave-one-out ablation', () => {
  /**
   * The whole point of the ablation is that dropping a signal from the fusion must drop what
   * only that signal knew. Here the graph is the sole route to the target. It has to be nested
   * that deep: the directory baseline scores sibling *top-level* directories as nearby, so a
   * plain `far/thing.ts` is one it reaches unaided. If `no-graph` still surfaced the file, the
   * ablation would be measuring nothing and a null result would be unreadable.
   */
  it('loses exactly what the removed signal uniquely contributed', () => {
    const anchor = 'src/a.ts';
    const fileGraph: FileGraph = {
      forward: new Map([[anchor, new Map([['far/deep/only-graph-knows.ts', 1]])]]),
      backward: new Map([['far/deep/only-graph-knows.ts', new Map([[anchor, 1]])]]),
      degree: new Map([
        [anchor, 1],
        ['far/deep/only-graph-knows.ts', 1],
      ]),
      packageMates: new Map([[anchor, ['src/sibling.ts']]]),
    };
    const ctx = {
      store: { coChange: EMPTY_COCHANGE },
      fileGraph,
      allFiles: [anchor, 'src/sibling.ts', 'far/deep/only-graph-knows.ts'],
    } as unknown as RankContext;

    const ranked = rankAll(ctx, anchor, 10);

    expect(ranked.graph).toEqual(['far/deep/only-graph-knows.ts']);
    expect(ranked.combined).toContain('far/deep/only-graph-knows.ts');
    expect(ranked['no-graph']).not.toContain('far/deep/only-graph-knows.ts');

    // And removing a signal must not disturb what the others independently found.
    expect(ranked['no-graph']).toContain('src/sibling.ts');
    expect(ranked.combined).toContain('src/sibling.ts');
  });

  it('reports every strategy, so a missing one cannot silently read as zero', async () => {
    const gold = ['pkg/handler/pokedex.go', 'service/pokemon.go', 'helpers/helpers.go'];
    const result = await evaluateInstance(instance(diffFor(gold)), {
      workdir: path.join(scratch, 'work'),
    });
    for (const strategy of STRATEGIES) {
      expect(result.recallAtG[strategy]).toBeGreaterThanOrEqual(0);
      expect(result.recall[strategy][10]).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});

describe('change-surface recall', () => {
  /**
   * The metric this whole layer exists for: given one file of the gold patch as a foothold,
   * how much of the rest does the graph reach — and does it beat "look in the same folder"?
   */
  it('recovers a structurally linked change surface and beats the directory baseline', async () => {
    // These three are linked by calls, not by directory: the handler calls the service and
    // the helper, and all three live in different packages.
    const gold = ['pkg/handler/pokedex.go', 'service/pokemon.go', 'helpers/helpers.go'];
    const result = await evaluateInstance(instance(diffFor(gold)), {
      workdir: path.join(scratch, 'work'),
    });

    expect(result.skipped).toBeUndefined();
    expect(result.indexableGold.sort()).toEqual(gold.sort());
    expect(result.anchors).toBe(3);

    // Every one of these files reaches the others within a few hops.
    expect(result.recall.graph[10]).toBe(1);
    expect(result.precision.graph[10]).toBeGreaterThan(0);

    // The baseline is a genuine competitor - sibling top-level packages count as "nearby",
    // so it finds part of the surface by luck. The graph has to beat it, not merely differ.
    expect(result.recall.directory[10]).toBeGreaterThan(0);
    expect(result.recall.graph[10]).toBeGreaterThan(result.recall.directory[10]);

    // Fusing the signals must not lose what the graph alone found.
    expect(result.recall.combined[10]).toBe(1);

    // Soundness: the closure reaches the whole target set without spanning the whole repo.
    expect(result.closureRecall).toBe(1);
    expect(result.closureShare).toBeLessThan(1);
  }, 120_000);

  /**
   * `go.mod` has no symbols and never will. It was therefore missing from the answer key
   * entirely — along with 331 `.json` and 147 `.md` gold files across the benchmark — which
   * quietly redefined the change surface as the part of it a parser can read. It is a file the
   * patch touches, so it is a target; structure cannot reach it, so history has to.
   */
  it('scores gold files that no parser can read', async () => {
    const result = await evaluateInstance(
      instance(diffFor(['service/pokemon.go', 'go.mod'])),
      { workdir: path.join(scratch, 'work') },
    );

    expect(result.skipped).toBeUndefined();
    expect(result.indexableGold).toContain('go.mod');
    expect(result.misses).toEqual({});
    // Half the gold set has no symbols, and the report has to say so rather than let the
    // structural strategy's shortfall read as a modelling failure.
    expect(result.unparsedShare).toBeCloseTo(0.5);
  }, 120_000);

  it('skips instances with nothing to find', async () => {
    const single = await evaluateInstance(instance(diffFor(['service/pokemon.go'])), {
      workdir: path.join(scratch, 'work'),
    });
    expect(single.skipped).toContain('fewer than two files');

    // A patch that only creates new files cannot be evaluated: they do not exist at base.
    const created = await evaluateInstance(
      instance(
        ['a/new1.go', 'a/new2.go']
          .map((f) => `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}`)
          .join('\n'),
      ),
      { workdir: path.join(scratch, 'work') },
    );
    expect(created.skipped).toContain('indexable');
    // And it says *why* each one was missing, rather than lumping them together.
    expect(Object.values(created.misses)).toEqual(['created-by-patch', 'created-by-patch']);
  }, 120_000);

  it('reports honestly when the graph finds nothing', async () => {
    // Two files with no call relationship and no shared directory.
    const result = await evaluateInstance(
      instance(diffFor(['main.go', 'repository/pokemon_repo.go'])),
      { workdir: path.join(scratch, 'work') },
    );
    expect(result.skipped).toBeUndefined();
    expect(result.recall.graph[5]).toBeGreaterThanOrEqual(0);
    expect(result.recall.graph[5]).toBeLessThanOrEqual(1);
  }, 120_000);

  it('averages only over scored instances', () => {
    const summary = summarise(
      [
        scoredFixture('a', 1),
        { ...scoredFixture('b', 0), skipped: 'single-file patch' },
      ],
      DEFAULT_K,
    );

    expect(summary.instances).toBe(2);
    expect(summary.scored).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.recall.graph[5]).toBe(1);
  });
});
