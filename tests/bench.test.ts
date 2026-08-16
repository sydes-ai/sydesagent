import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, taskText, type BenchInstance } from '../src/bench/dataset.js';
import { writeHarnessConfig } from '../src/bench/harness.js';
import { resolveImage, runInstance } from '../src/bench/runner.js';
import { extractPatch } from '../src/bench/workspace.js';
import { loadAgentConfig } from '../src/config.js';
import { LocalExec } from '../src/exec/local.js';
import type { MockScript } from '../src/llm/mock.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let scratch: string;
let originRepo: string;
let baseSha: string;

/** A local git repository standing in for the benchmark's upstream, so no network is needed. */
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'sydes-bench-'));
  originRepo = path.join(scratch, 'origin');
  await mkdir(originRepo, { recursive: true });
  await cp(GO_FIXTURE, originRepo, { recursive: true });

  const git = new LocalExec(originRepo);
  await git.run('git init -q -b main');
  await git.run('git config user.email sydes@test.local && git config user.name Sydes');
  await git.run('git add -A && git commit -q -m "base"');
  const sha = await git.run('git rev-parse HEAD');
  baseSha = sha.stdout.trim();
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function instance(): BenchInstance {
  return {
    org: 'example',
    repo: 'pokedex',
    number: 2787,
    base: { label: 'main', ref: 'main', sha: baseSha },
    title: 'Power limit is too permissive',
    body: 'Pokemon with power above 1000 are accepted. Lower the limit to 500.',
    resolved_issues: [{ number: 11, title: 'Overpowered pokemon accepted', body: 'Please cap it.' }],
    fix_patch: 'THIS MUST NOT REACH THE AGENT',
    test_patch: 'THIS MUST NOT REACH THE AGENT EITHER',
    lang: 'go',
    repo_url: originRepo,
  };
}

describe('dataset', () => {
  it('parses the official field names and filters', async () => {
    const file = path.join(scratch, 'dataset.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify(instance()),
        JSON.stringify({ ...instance(), number: 3, lang: 'rust', repo: 'other' }),
      ].join('\n') + '\n',
    );

    const all = await loadDataset([file]);
    expect(all).toHaveLength(2);
    expect(all[0].base.sha).toBe(baseSha);

    const goOnly = await loadDataset([file], { langs: ['go'] });
    expect(goOnly).toHaveLength(1);

    const byId = await loadDataset([file], { ids: ['example__pokedex-2787'] });
    expect(byId).toHaveLength(1);

    expect(await loadDataset([file], { limit: 1 })).toHaveLength(1);
  });

  /**
   * Real dataset files run past V8's 512MB maximum string length — svelte's is ~480MB — so
   * reading one whole throws `Invalid string length` before a single record is parsed. The
   * loader streams instead, and keeps only the fields we use: a record carries the entire
   * stdout of the reference test runs, which is most of its bytes and is never read.
   */
  it('streams records and drops the reference test logs', async () => {
    const file = path.join(scratch, 'fat.jsonl');
    const noise = 'x'.repeat(200_000);
    const rows = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        ...instance(),
        number: i + 1,
        run_result: noise,
        fix_patch_result: noise,
        test_patch_result: noise,
        p2p_tests: [noise],
      }),
    );
    await writeFile(file, rows.join('\n') + '\n');

    const loaded = await loadDataset([file]);
    expect(loaded).toHaveLength(20);
    expect(loaded[0].fix_patch).toBe('THIS MUST NOT REACH THE AGENT');

    // The megabytes of log never enter memory.
    const kept = loaded[0] as unknown as Record<string, unknown>;
    for (const dropped of ['run_result', 'fix_patch_result', 'test_patch_result', 'p2p_tests']) {
      expect(kept[dropped], `${dropped} should be dropped`).toBeUndefined();
    }
    const retained = JSON.stringify(loaded).length;
    const onDisk = rows.join('\n').length;
    expect(retained).toBeLessThan(onDisk / 10);
  });

  it('stops reading once the limit is reached', async () => {
    const file = path.join(scratch, 'many.jsonl');
    const rows = Array.from({ length: 50 }, (_, i) => JSON.stringify({ ...instance(), number: i + 1 }));
    await writeFile(file, rows.join('\n') + '\n');

    expect(await loadDataset([file], { limit: 3 })).toHaveLength(3);
  });

  /** The reference patches are the answer key; leaking them would invalidate every result. */
  it('builds the task from the issue text only, never the patches', () => {
    const text = taskText(instance());
    expect(text).toContain('Power limit is too permissive');
    expect(text).toContain('Linked issue #11');
    expect(text).not.toContain('MUST NOT REACH THE AGENT');
  });
});

describe('instance run', () => {
  it('prepares a workspace at the base commit, runs the agent and emits a prediction', async () => {
    const script: MockScript = [
      { toolCalls: [{ name: 'graph_expand', arguments: { anchor: 'service/pokemon.go' } }] },
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power > 500 {',
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'power must be 1000 or less',
              new_string: 'power must be 500 or less',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'verify', arguments: {} }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'lowered the cap to 500' } }] },
    ];

    const result = await runInstance(instance(), {
      workdir: path.join(scratch, 'work'),
      outDir: path.join(scratch, 'runs'),
      graph: true,
      provider: { provider: 'mock', model: 'mock-model', script },
      config: loadAgentConfig({ maxTurns: 8 }),
      exec: 'local',
    });

    expect(result.instanceId).toBe('example__pokedex-2787');
    expect(result.prediction).toMatchObject({ org: 'example', repo: 'pokedex', number: 2787 });
    expect(result.prediction.fix_patch).toContain('diff --git a/service/pokemon.go');
    expect(result.prediction.fix_patch).toContain('-\tif p.Power > 1000 {');
    expect(result.prediction.fix_patch).toContain('+\tif p.Power > 500 {');

    // The graph selected the tests, and they ran for real.
    expect(result.metrics.testRuns).toBeGreaterThan(0);
    expect(result.metrics.filesEdited).toBe(1);

    const written = JSON.parse(
      await readFile(path.join(scratch, 'runs', result.instanceId, 'metrics.json'), 'utf8'),
    );
    expect(written.runId).toBe('example__pokedex-2787-graph');
    const trace = await readFile(path.join(scratch, 'runs', result.instanceId, 'trace.jsonl'), 'utf8');
    expect(trace.split('\n').filter(Boolean).length).toBeGreaterThan(5);
  }, 180_000);

  it('keeps test-file edits out of the patch, since the harness applies its own', async () => {
    const workspace = path.join(scratch, 'work', 'workspaces', 'example__pokedex-2787');
    await writeFile(path.join(workspace, 'service/extra.go'), 'package service\n\nfunc Extra() {}\n');
    await writeFile(
      path.join(workspace, 'service/extra_test.go'),
      'package service\n\nimport "testing"\n\nfunc Test_Extra(t *testing.T) { Extra() }\n',
    );

    const patch = await extractPatch(workspace);
    expect(patch).toContain('service/extra.go');
    expect(patch).not.toContain('service/extra_test.go');

    const withTests = await extractPatch(workspace, { excludeTests: false });
    expect(withTests).toContain('service/extra_test.go');
  }, 120_000);
});

/**
 * The official harness builds one image per pull request — `mswebench/cli_m_cli:pr-10154`, not
 * one image per repository. A single `--exec docker:<image>` therefore cannot serve a sweep,
 * and because `local` is the default, an entire A/B ran on the host instead: cli/cli could not
 * build there, all 27 test runs failed, and the verification loop was inert for the whole
 * experiment while reporting nothing unusual.
 */
describe('per-instance execution images', () => {
  const instance = { org: 'cli', repo: 'cli', number: 10154 } as BenchInstance;

  it('substitutes the instance into an image template', () => {
    expect(resolveImage('mswebench/{org}_m_{repo}:pr-{number}', instance)).toBe(
      'mswebench/cli_m_cli:pr-10154',
    );
    expect(resolveImage('local/{id}', instance)).toBe('local/cli__cli-10154');
  });

  it('leaves a plain image name alone, so a fixed image still works', () => {
    expect(resolveImage('golang:1.22', instance)).toBe('golang:1.22');
  });

  // The images check the repository out at /home/<repo>, so the container workdir is per-repo
  // for the same reason the image tag is per-instance.
  it('resolves the container workdir the same way', () => {
    expect(resolveImage('/home/{repo}', instance)).toBe('/home/cli');
    expect(
      resolveImage('/home/{repo}', { org: 'mui', repo: 'material-ui', number: 1 } as BenchInstance),
    ).toBe('/home/material-ui');
  });
});

describe('official harness wiring', () => {
  /**
   * The evaluator validates these directories before it starts and does not create them, so a
   * config that names paths nobody has made fails as `Workdir not found` — which reads like a
   * wrong path rather than a missing directory. `repo_dir` is checked for a real value rather
   * than mere presence: it was emitted as `null`, the sibling test asserted only that the key
   * existed, and the harness types the field as non-optional and rejected it.
   */
  it('creates every directory the evaluator requires, with a usable repo_dir', async () => {
    const outputDir = path.join(scratch, 'score-dirs');
    const workdir = path.join(scratch, 'harness-dirs');
    const configPath = await writeHarnessConfig({
      workdir,
      outputDir,
      logDir: path.join(outputDir, 'logs'),
      datasetFiles: ['dataset.jsonl'],
      patchFiles: ['predictions.jsonl'],
    });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(typeof config.repo_dir).toBe('string');
    expect(config.repo_dir.length).toBeGreaterThan(0);

    for (const dir of [config.workdir, config.output_dir, config.log_dir, config.repo_dir]) {
      expect(existsSync(dir), `harness directory not created: ${dir}`).toBe(true);
    }
  });

  it('writes a config with the field names the evaluator expects', async () => {
    const outputDir = path.join(scratch, 'score');
    const configPath = await writeHarnessConfig({
      workdir: path.join(scratch, 'harness'),
      outputDir,
      logDir: path.join(outputDir, 'logs'),
      datasetFiles: ['dataset.jsonl'],
      patchFiles: ['predictions.jsonl'],
    });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.mode).toBe('evaluation');
    expect(Object.keys(config)).toEqual(
      expect.arrayContaining([
        'workdir',
        'patch_files',
        'dataset_files',
        'force_build',
        'output_dir',
        'specifics',
        'skips',
        'repo_dir',
        'need_clone',
        'global_env',
        'clear_env',
        'stop_on_error',
        'max_workers',
        'max_workers_build_image',
        'max_workers_run_instance',
        'log_dir',
        'log_level',
      ]),
    );
    expect(path.isAbsolute(config.patch_files[0])).toBe(true);
  });
});
