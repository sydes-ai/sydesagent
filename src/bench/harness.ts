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
  /**
   * Instances the harness could not evaluate, as opposed to ones the patch failed to fix.
   *
   * These were invisible: the wrapper read only the resolved and unresolved arrays, so a
   * container that never ran and a patch that fixed nothing produced the same output. That is
   * a bad thing not to be able to tell apart when the answer is zero.
   */
  incomplete?: number;
  errored?: number;
  emptyPatch?: number;
  raw?: unknown;
  output: string;
}

export async function writeHarnessConfig(options: HarnessOptions): Promise<string> {
  const workdir = path.resolve(options.workdir);
  const outputDir = path.resolve(options.outputDir);
  const logDir = path.resolve(options.logDir);
  // The harness clones into `repo_dir` and rejects a null one: its CliArgs types the field as
  // non-optional, so a null decodes to a warning and then fails validation further in. Default
  // it under the workdir rather than making every caller supply a path they do not care about.
  const repoDir = path.resolve(options.repoDir ?? path.join(workdir, 'repos'));

  // All three are validated for existence before the run starts, and the harness does not
  // create them. Scoring failed here as `Workdir not found`, which reads like a bad path
  // rather than a directory nobody had made yet.
  await Promise.all([
    mkdir(workdir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
    mkdir(logDir, { recursive: true }),
    mkdir(repoDir, { recursive: true }),
  ]);

  const config = {
    mode: 'evaluation',
    workdir,
    patch_files: options.patchFiles.map((f) => path.resolve(f)),
    dataset_files: options.datasetFiles.map((f) => path.resolve(f)),
    force_build: options.forceBuild ?? false,
    output_dir: outputDir,
    specifics: [],
    skips: [],
    repo_dir: repoDir,
    need_clone: options.needClone ?? true,
    global_env: [],
    clear_env: true,
    stop_on_error: false,
    max_workers: options.maxWorkers ?? 4,
    max_workers_build_image: options.maxWorkers ?? 4,
    max_workers_run_instance: options.maxWorkers ?? 4,
    log_dir: logDir,
    log_level: 'INFO',
  };

  const configPath = path.join(outputDir, 'harness-config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export async function runOfficialHarness(options: HarnessOptions): Promise<HarnessReport> {
  const configPath = await writeHarnessConfig(options);
  // `python3` rather than `python`: Debian and Ubuntu ship no bare `python`, and macOS
  // dropped it in 12.3. A shell alias does not rescue this — commands are spawned through
  // `/bin/sh -c`, which never reads interactive aliases, so the failure looked like a missing
  // harness rather than a missing interpreter.
  const python = options.python ?? 'python3';
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
    incomplete: raw?.incomplete_instances,
    errored: raw?.error_instances,
    emptyPatch: raw?.empty_patch_instances,
    unresolved: Array.isArray(raw?.unresolved_instances)
      ? raw.unresolved_instances.length
      : raw?.unresolved_instances,
    raw,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-8000),
  };
}
