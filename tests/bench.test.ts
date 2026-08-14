import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, taskText, type BenchInstance } from '../src/bench/dataset.js';
import { writeHarnessConfig } from '../src/bench/harness.js';
import { runInstance } from '../src/bench/runner.js';
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

describe('official harness wiring', () => {
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
