/**
 * Per-instance workspaces.
 *
 * A bare mirror is cached per repository so a benchmark sweep clones each project once, then
 * every instance gets a cheap local clone pinned to its base commit.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { LocalExec } from '../exec/local.js';
import type { ExecResult } from '../exec/types.js';
import type { BenchInstance } from './dataset.js';
import { instanceId, repoUrl } from './dataset.js';

const TEST_PATH = /(^|\/)(tests?|__tests__|testdata|spec)\/|(_test\.\w+$)|(\.(test|spec)\.[cm]?[jt]sx?$)|(Test[A-Z]\w*\.java$)|(\w+Test\.java$)/;

async function git(cwd: string, command: string, timeoutMs = 600_000): Promise<ExecResult> {
  return new LocalExec(cwd).run(command, { timeoutMs });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export interface PreparedWorkspace {
  root: string;
  instanceId: string;
}

export async function prepareWorkspace(
  instance: BenchInstance,
  options: { workdir: string; fresh?: boolean },
): Promise<PreparedWorkspace> {
  const id = instanceId(instance);
  const mirrorDir = path.join(options.workdir, 'mirrors', `${instance.org}__${instance.repo}.git`);
  const workspace = path.join(options.workdir, 'workspaces', id);

  await mkdir(path.dirname(mirrorDir), { recursive: true });
  await mkdir(path.dirname(workspace), { recursive: true });

  if (!(await exists(mirrorDir))) {
    // Deliberately not a partial clone. `--filter=blob:none` makes the mirror a promisor
    // repo, and a workspace cloned *from* that mirror asks it for blobs it does not have,
    // so every checkout fails with "unable to read sha1 file". The mirror is created once
    // per repository and reused by every instance of it, so paying for it in full is cheap.
    const clone = await git(
      path.dirname(mirrorDir),
      `git clone --bare ${repoUrl(instance)} ${JSON.stringify(mirrorDir)}`,
    );
    if (clone.exitCode !== 0) {
      throw new Error(`clone of ${repoUrl(instance)} failed: ${clone.stderr.trim().slice(0, 400)}`);
    }
  }

  if (options.fresh !== false) await rm(workspace, { recursive: true, force: true });
  if (!(await exists(workspace))) {
    const clone = await git(
      path.dirname(workspace),
      `git clone --no-checkout ${JSON.stringify(mirrorDir)} ${JSON.stringify(workspace)}`,
    );
    if (clone.exitCode !== 0) {
      throw new Error(`local clone failed: ${clone.stderr.trim().slice(0, 400)}`);
    }
  }

  // Fetch the exact base commit in case the mirror predates it.
  await git(workspace, `git fetch --quiet origin ${instance.base.sha}`);
  const checkout = await git(workspace, `git checkout --quiet --force ${instance.base.sha}`);
  if (checkout.exitCode !== 0) {
    throw new Error(`checkout of ${instance.base.sha} failed: ${checkout.stderr.trim().slice(0, 400)}`);
  }
  await git(workspace, 'git clean -qfdx');

  return { root: workspace, instanceId: id };
}

export interface PatchOptions {
  /** Drop changes to test files: the harness applies its own test patch on top. */
  excludeTests?: boolean;
}

/** The agent's work as a unified diff against the base commit. */
export async function extractPatch(root: string, options: PatchOptions = {}): Promise<string> {
  await git(root, 'git add -A');
  const status = await git(root, 'git diff --cached --name-only');
  const files = status.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!files.length) return '';

  const wanted = options.excludeTests === false ? files : files.filter((f) => !TEST_PATH.test(f));
  if (!wanted.length) return '';

  const args = wanted.map((f) => JSON.stringify(f)).join(' ');
  const diff = await git(root, `git diff --cached --binary -- ${args}`);
  return diff.stdout;
}

export function isTestPath(file: string): boolean {
  return TEST_PATH.test(file);
}
