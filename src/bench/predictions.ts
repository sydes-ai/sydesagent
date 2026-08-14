import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchInstance } from './dataset.js';

/** Exactly the shape the official evaluator reads. */
export interface Prediction {
  org: string;
  repo: string;
  number: number | string;
  fix_patch: string;
}

export function toPrediction(instance: BenchInstance, fixPatch: string): Prediction {
  return {
    org: instance.org,
    repo: instance.repo,
    number: instance.number,
    fix_patch: fixPatch,
  };
}

export async function writePredictions(file: string, predictions: Prediction[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n');
}
