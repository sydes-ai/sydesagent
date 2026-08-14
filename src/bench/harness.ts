/**
 * Thin wrapper around the official Multi-SWE-bench evaluator.
 *
 * Scoring stays with the upstream harness: it owns the instance images, applies the held-out
 * test patch and decides what "resolved" means. Reimplementing that here would only create a
 * second, less trustworthy definition of success.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalExec } from '../exec/local.js';

export interface HarnessOptions {
  /** Directory the harness uses for images and build state. */
  workdir: string;
  outputDir: string;
  logDir: string;
  datasetFiles: string[];
  patchFiles: string[];
  maxWorkers?: number;
  python?: string;
  forceBuild?: boolean;
  repoDir?: string;
  needClone?: boolean;
}

export interface HarnessReport {
  ok: boolean;
  configPath: string;
  reportPath: string;
  resolved?: number;
  unresolved?: number;
  raw?: unknown;
  output: string;
}

export async function writeHarnessConfig(options: HarnessOptions): Promise<string> {
  const config = {
    mode: 'evaluation',
    workdir: path.resolve(options.workdir),
    patch_files: options.patchFiles.map((f) => path.resolve(f)),
    dataset_files: options.datasetFiles.map((f) => path.resolve(f)),
    force_build: options.forceBuild ?? false,
    output_dir: path.resolve(options.outputDir),
    specifics: [],
    skips: [],
    repo_dir: options.repoDir ? path.resolve(options.repoDir) : null,
    need_clone: options.needClone ?? true,
    global_env: [],
    clear_env: true,
    stop_on_error: false,
    max_workers: options.maxWorkers ?? 4,
    max_workers_build_image: options.maxWorkers ?? 4,
    max_workers_run_instance: options.maxWorkers ?? 4,
    log_dir: path.resolve(options.logDir),
    log_level: 'INFO',
  };

  const configPath = path.join(path.resolve(options.outputDir), 'harness-config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export async function runOfficialHarness(options: HarnessOptions): Promise<HarnessReport> {
  const configPath = await writeHarnessConfig(options);
  const python = options.python ?? 'python';
  const exec = new LocalExec(process.cwd(), 3_600_000);

  const result = await exec.run(
    `${python} -m multi_swe_bench.harness.run_evaluation --config ${JSON.stringify(configPath)}`,
    { timeoutMs: 3_600_000 },
  );

  const reportPath = path.join(path.resolve(options.outputDir), 'final_report.json');
  let raw: any;
  try {
    raw = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    raw = undefined;
  }

  return {
    ok: result.exitCode === 0 && raw !== undefined,
    configPath,
    reportPath,
    resolved: Array.isArray(raw?.resolved_instances)
      ? raw.resolved_instances.length
      : raw?.resolved_instances,
    unresolved: Array.isArray(raw?.unresolved_instances)
      ? raw.unresolved_instances.length
      : raw?.unresolved_instances,
    raw,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-8000),
  };
}
