/**
 * Evolutionary coupling: which files this repository's own history changed together.
 *
 * This exists because two independent failures pointed at the same missing signal. Docs,
 * configs and lockfiles co-change with code constantly — 173 markdown files appeared in the
 * gold patches of one benchmark run — and an AST graph can never reach them, because there is
 * no syntactic relationship to find. Separately, two files in the same Go package co-change
 * constantly and frequently have no call edge between them. History sees both.
 *
 * No leakage: the workspace is checked out at the instance's base commit, so `git log` from
 * HEAD is strictly the past. The change being predicted is not in it.
 */
import { execFile } from 'node:child_process';

export interface CoChangeOptions {
  /** How far back to read. Older history is less predictive and costs time. */
  maxCommits?: number;
  /**
   * A hard ceiling on commit size, for cost rather than for signal.
   *
   * This used to be 25 and was the whole defence against noise, which discarded far too much:
   * one repository scored zero co-change because its ordinary commits are large. Commit size
   * is now handled by weighting rather than by a cliff, and this only bounds the quadratic
   * pair generation of a thousand-file codemod.
   */
  maxFilesPerCommit?: number;
}

export interface CoChangeIndex {
  /** file -> co-changed file -> summed weight of the commits containing both. */
  pairs: Map<string, Map<string, number>>;
  /** file -> summed weight of the commits touching it, for normalising. */
  commits: Map<string, number>;
  /** Summed weight of every commit read. Not a count — see the weighting in `buildCoChange`. */
  totalWeight: number;
}

export const EMPTY_COCHANGE: CoChangeIndex = {
  pairs: new Map(),
  commits: new Map(),
  totalWeight: 0,
};

function readLog(root: string, maxCommits: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'log', `-n${maxCommits}`, '--name-only', '--no-merges', '--pretty=format:%x00'],
      { maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

export async function buildCoChange(
  root: string,
  options: CoChangeOptions = {},
): Promise<CoChangeIndex> {
  const maxCommits = options.maxCommits ?? 3000;
  const maxFiles = options.maxFilesPerCommit ?? 400;

  const log = await readLog(root, maxCommits);
  if (!log) return EMPTY_COCHANGE;

  const pairs = new Map<string, Map<string, number>>();
  const commits = new Map<string, number>();
  let totalWeight = 0;

  const link = (a: string, b: string, weight: number) => {
    let row = pairs.get(a);
    if (!row) pairs.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + weight);
  };

  // `%x00` writes a NUL before each commit's file list, so commits split cleanly even when a
  // commit message contains blank lines.
  for (const chunk of log.split('\0')) {
    const files = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length < 2 || files.length > maxFiles) continue;

    // Adamic-Adar: a commit touching two files says those two belong together; a commit
    // touching eighty says almost nothing about any particular pair within it. Weighting by
    // 1/log(n) expresses that as a gradient, where the old 25-file cutoff expressed it as a
    // cliff that threw away every large commit — and with it every repository whose ordinary
    // commits are large.
    const weight = 1 / Math.log(1 + files.length);
    totalWeight += weight;
    for (const file of files) commits.set(file, (commits.get(file) ?? 0) + weight);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        link(files[i], files[j], weight);
        link(files[j], files[i], weight);
      }
    }
  }

  return { pairs, commits, totalWeight };
}

/**
 * Files most often changed alongside `file`, scored by lift rather than raw count.
 *
 * Raw co-occurrence favours whatever churns most — a changelog or a version file pairs with
 * everything. Lift asks whether the pair occurs more than independence would predict, which
 * is what "these belong together" actually means.
 */
export function coChangeNeighbours(
  index: CoChangeIndex,
  file: string,
  limit: number,
): { file: string; score: number }[] {
  const row = index.pairs.get(file);
  if (!row || !index.totalWeight) return [];
  const own = index.commits.get(file) || 1;

  const scored: { file: string; score: number }[] = [];
  for (const [other, together] of row) {
    const otherCount = index.commits.get(other) || 1;
    // lift = P(a,b) / (P(a)P(b)), computed on commit counts.
    const lift = (together * index.totalWeight) / (own * otherCount);
    // Thin evidence is weak however high its lift; damp by how much support there is.
    scored.push({ file: other, score: lift * Math.log1p(together) });
  }

  return scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
}
