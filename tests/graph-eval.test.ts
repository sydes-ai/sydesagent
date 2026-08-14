import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BenchInstance } from '../src/bench/dataset.js';
import { DEFAULT_K, evaluateInstance, summarise } from '../src/bench/graph-eval.js';
import { changedFiles, parsePatchFiles } from '../src/bench/patch.js';
import { LocalExec } from '../src/exec/local.js';

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
    expect(result.recall[10]).toBe(1);
    expect(result.precision[10]).toBeGreaterThan(0);

    // The baseline is a genuine competitor - sibling top-level packages count as "nearby",
    // so it finds part of the surface by luck. The graph has to beat it, not merely differ.
    expect(result.baselineRecall[10]).toBeGreaterThan(0);
    expect(result.recall[10]).toBeGreaterThan(result.baselineRecall[10]);
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
  }, 120_000);

  it('reports honestly when the graph finds nothing', async () => {
    // Two files with no call relationship and no shared directory.
    const result = await evaluateInstance(
      instance(diffFor(['main.go', 'repository/pokemon_repo.go'])),
      { workdir: path.join(scratch, 'work') },
    );
    expect(result.skipped).toBeUndefined();
    expect(result.recall[5]).toBeGreaterThanOrEqual(0);
    expect(result.recall[5]).toBeLessThanOrEqual(1);
  }, 120_000);

  it('averages only over scored instances', () => {
    const summary = summarise(
      [
        {
          instanceId: 'a',
          goldFiles: [],
          indexableGold: [],
          anchors: 2,
          recall: { 5: 1, 10: 1, 20: 1 },
          precision: { 5: 0.5, 10: 0.5, 20: 0.5 },
          baselineRecall: { 5: 0, 10: 0, 20: 0 },
        },
        {
          instanceId: 'b',
          goldFiles: [],
          indexableGold: [],
          anchors: 0,
          recall: { 5: 0, 10: 0, 20: 0 },
          precision: { 5: 0, 10: 0, 20: 0 },
          baselineRecall: { 5: 0, 10: 0, 20: 0 },
          skipped: 'single-file patch',
        },
      ],
      DEFAULT_K,
    );

    expect(summary.instances).toBe(2);
    expect(summary.scored).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.recall[5]).toBe(1);
  });
});
