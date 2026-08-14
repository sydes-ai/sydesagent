import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BenchInstance } from '../src/bench/dataset.js';
import { runSweep } from '../src/bench/sweep.js';
import { loadAgentConfig } from '../src/config.js';
import { LocalExec } from '../src/exec/local.js';
import type { MockScript } from '../src/llm/mock.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let scratch: string;
let originRepo: string;
let baseSha: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'sydes-sweep-'));
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

function instance(number: number): BenchInstance {
  return {
    org: 'example',
    repo: 'pokedex',
    number,
    base: { sha: baseSha },
    title: `Task ${number}`,
    body: 'Lower the power cap.',
    lang: 'go',
    repo_url: originRepo,
  };
}

const script: MockScript = [
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
  { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
];

function options(outDir: string, extra: Record<string, unknown> = {}) {
  return {
    workdir: path.join(scratch, 'work'),
    outDir,
    graph: true,
    provider: { provider: 'mock' as const, model: 'mock-model', script },
    config: loadAgentConfig({ maxTurns: 5, compileAfterEdit: false }),
    exec: 'local' as const,
    ...extra,
  };
}

describe('sweep', () => {
  /** A sweep that dies at instance 38 of 40 must not re-run the first 37. */
  it('resumes completed instances instead of re-running them', async () => {
    const outDir = path.join(scratch, 'runs-resume');

    const first = await runSweep([instance(1), instance(2)], options(outDir));
    expect(first.results).toHaveLength(2);
    expect(first.resumed).toBe(0);

    const second = await runSweep([instance(1), instance(2), instance(3)], options(outDir));
    expect(second.resumed).toBe(2);
    expect(second.results).toHaveLength(3);
  }, 180_000);

  it('re-runs everything when asked to', async () => {
    const outDir = path.join(scratch, 'runs-fresh');
    await runSweep([instance(1)], options(outDir));
    const again = await runSweep([instance(1)], options(outDir, { fresh: true }));
    expect(again.resumed).toBe(0);
  }, 180_000);

  /** Results must be durable the moment they exist, not at the end of the sweep. */
  it('writes predictions after every instance', async () => {
    const outDir = path.join(scratch, 'runs-durable');
    const seen: number[] = [];

    await runSweep([instance(1), instance(2)], {
      ...options(outDir),
      // Synchronous on purpose: `onProgress` is fire-and-forget, so an async probe here
      // would race the sweep's completion and read a stale file.
      onProgress: () => {
        const raw = readFileSync(path.join(outDir, 'predictions.jsonl'), 'utf8');
        seen.push(raw.split('\n').filter(Boolean).length);
      },
    });

    // One prediction on disk after the first instance, two after the second.
    expect(seen).toEqual([1, 2]);
  }, 180_000);

  it('stops before starting work that would exceed the cost ceiling', async () => {
    const outDir = path.join(scratch, 'runs-ceiling');
    // The mock model is priced at zero, so any positive ceiling is never reached; a zero
    // ceiling means "already at the limit" and must stop before the first instance.
    const outcome = await runSweep([instance(1), instance(2)], options(outDir, { maxCostUsd: 0 }));

    expect(outcome.results).toHaveLength(0);
    expect(outcome.stoppedEarly).toContain('cost ceiling');
  }, 120_000);

  it('records a failure and keeps going', async () => {
    const outDir = path.join(scratch, 'runs-failure');
    const broken: BenchInstance = { ...instance(9), base: { sha: 'not-a-real-commit' } };

    const outcome = await runSweep([broken, instance(10)], options(outDir));

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].instanceId).toBe('example__pokedex-9');
    expect(outcome.results).toHaveLength(1);
  }, 180_000);

  it('runs instances concurrently', async () => {
    const outDir = path.join(scratch, 'runs-parallel');
    const outcome = await runSweep(
      [instance(20), instance(21), instance(22)],
      options(outDir, { workers: 3 }),
    );
    expect(outcome.results).toHaveLength(3);
    expect(new Set(outcome.results.map((r) => r.instanceId)).size).toBe(3);
  }, 240_000);
});
