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
   * Commits touching more than this are ignored. Merges, formatting sweeps and codemods
   * touch hundreds of files and couple everything to everything, which is noise, not signal.
   */
  maxFilesPerCommit?: number;
}

export interface CoChangeIndex {
  /** file -> co-changed file -> number of commits containing both. */
  pairs: Map<string, Map<string, number>>;
  /** file -> number of commits touching it, for normalising. */
  commits: Map<string, number>;
  commitsRead: number;
}

export const EMPTY_COCHANGE: CoChangeIndex = {
  pairs: new Map(),
  commits: new Map(),
  commitsRead: 0,
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
  const maxFiles = options.maxFilesPerCommit ?? 25;

  const log = await readLog(root, maxCommits);
  if (!log) return EMPTY_COCHANGE;

  const pairs = new Map<string, Map<string, number>>();
  const commits = new Map<string, number>();
  let commitsRead = 0;

  const link = (a: string, b: string) => {
    let row = pairs.get(a);
    if (!row) pairs.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  };

  // `%x00` writes a NUL before each commit's file list, so commits split cleanly even when a
  // commit message contains blank lines.
  for (const chunk of log.split('\0')) {
    const files = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length < 2 || files.length > maxFiles) continue;

    commitsRead++;
    for (const file of files) commits.set(file, (commits.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        link(files[i], files[j]);
        link(files[j], files[i]);
      }
    }
  }

  return { pairs, commits, commitsRead };
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
  if (!row || !index.commitsRead) return [];
  const own = index.commits.get(file) ?? 1;

  const scored: { file: string; score: number }[] = [];
  for (const [other, together] of row) {
    const otherCount = index.commits.get(other) ?? 1;
    // lift = P(a,b) / (P(a)P(b)), computed on commit counts.
    const lift = (together * index.commitsRead) / (own * otherCount);
    // A single shared commit is weak evidence however high its lift; damp by support.
    scored.push({ file: other, score: lift * Math.log1p(together) });
  }

  return scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
}
