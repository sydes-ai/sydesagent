/**
 * Running a sweep without losing work or money.
 *
 * A benchmark sweep is long, costs real money, and fails in the middle. Three properties make
 * that survivable: completed instances are never re-run, results are durable the moment they
 * exist, and a spend ceiling stops a runaway before it empties an account. None of this is
 * interesting engineering; all of it is the difference between an experiment you can run and
 * one you can only start.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchInstance } from './dataset.js';
import { instanceId } from './dataset.js';
import type { Prediction } from './predictions.js';
import { runInstance, type BenchOptions, type InstanceResult } from './runner.js';

/** Written per instance so a resumed sweep can skip finished work. */
const RESULT_FILE = 'result.json';

export interface SweepOptions extends BenchOptions {
  /** Instances to run concurrently. */
  workers?: number;
  /** Stop starting new instances once accumulated cost passes this, in USD. */
  maxCostUsd?: number;
  /** Re-run instances that already have a result. */
  fresh?: boolean;
  onProgress?: (line: string) => void;
}

export interface SweepOutcome {
  results: InstanceResult[];
  resumed: number;
  failed: { instanceId: string; error: string }[];
  stoppedEarly?: string;
  costUsd: number;
}

async function loadExisting(outDir: string, id: string): Promise<InstanceResult | undefined> {
  try {
    return JSON.parse(await readFile(path.join(outDir, id, RESULT_FILE), 'utf8')) as InstanceResult;
  } catch {
    return undefined;
  }
}

async function saveResult(outDir: string, result: InstanceResult): Promise<void> {
  const dir = path.join(outDir, result.instanceId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, RESULT_FILE), JSON.stringify(result, null, 2));
}

/** Rewritten after every instance, so a crash never costs more than the run in flight. */
async function flushPredictions(file: string, predictions: Prediction[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n');
}

export async function runSweep(
  instances: BenchInstance[],
  options: SweepOptions,
): Promise<SweepOutcome> {
  const workers = Math.max(1, options.workers ?? 1);
  const predictionsFile = path.join(options.outDir, 'predictions.jsonl');

  const results: InstanceResult[] = [];
  const failed: SweepOutcome['failed'] = [];
  let resumed = 0;
  let costUsd = 0;
  let stoppedEarly: string | undefined;
  let cursor = 0;

  const total = instances.length;
  const done = async (result: InstanceResult, note: string, index: number) => {
    results.push(result);
    costUsd += result.metrics.costUsd;
    await flushPredictions(
      predictionsFile,
      results.map((r) => r.prediction),
    );
    options.onProgress?.(
      `(${index + 1}/${total}) ${result.instanceId} — ${note}, $${costUsd.toFixed(4)} spent`,
    );
  };

  const worker = async () => {
    while (true) {
      if (stoppedEarly) return;
      const index = cursor++;
      if (index >= instances.length) return;

      const instance = instances[index];
      const id = instanceId(instance);

      if (!options.fresh) {
        const existing = await loadExisting(options.outDir, id);
        if (existing) {
          resumed++;
          await done(existing, 'resumed from a previous run', index);
          continue;
        }
      }

      // Checked before starting rather than after finishing: the point is not to begin work
      // that will push us past the ceiling.
      if (options.maxCostUsd !== undefined && costUsd >= options.maxCostUsd) {
        stoppedEarly = `cost ceiling of $${options.maxCostUsd.toFixed(2)} reached after ${results.length} instance(s)`;
        return;
      }

      try {
        const result = await runInstance(instance, options);
        await saveResult(options.outDir, result);
        await done(
          result,
          `${result.patchBytes ? `${result.patchBytes}b patch` : 'no patch'}, ${result.metrics.modelCalls} model calls`,
          index,
        );
      } catch (error) {
        failed.push({ instanceId: id, error: (error as Error).message });
        options.onProgress?.(`(${index + 1}/${total}) ${id} — failed: ${(error as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { results, resumed, failed, stoppedEarly, costUsd };
}
