import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.sydes',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode',
]);

export interface WalkOptions {
  ignoredDirs?: Set<string>;
  extraIgnores?: string[];
  maxFileBytes?: number;
}

/**
 * Turns .gitignore lines into a predicate over repo-relative POSIX paths.
 *
 * Negation is not optional. The "ignore everything, then re-admit what matters" idiom is
 * common in real repositories - go-zero opens with exactly this:
 *
 *     *
 *     !*.*
 *     !*\/
 *
 * Dropping the `!` rules leaves the bare `*`, which excludes the entire repository. The
 * failure is silent: the walk returns nothing, the graph indexes zero files, and the agent
 * runs against an empty graph looking exactly like a graph that did not help. So rules are
 * evaluated in order with last-match-wins, as git does.
 */
function gitignoreMatcher(patterns: string[]): (relPath: string, isDir: boolean) => boolean {
  const rules = patterns
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const withoutBang = negated ? line.slice(1) : line;
      const dirOnly = withoutBang.endsWith('/');
      const body = dirOnly ? withoutBang.slice(0, -1) : withoutBang;
      const anchored = body.startsWith('/');
      const clean = anchored ? body.slice(1) : body;
      const rx = new RegExp(
        `^${clean
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, ' ')
          .replace(/\*/g, '[^/]*')
          .replace(/ /g, '.*')
          .replace(/\?/g, '[^/]')}$`,
      );
      return { rx, dirOnly, anchored, negated };
    });

  const matches = (rule: (typeof rules)[number], relPath: string, isDir: boolean): boolean => {
    if (rule.dirOnly && !isDir) return false;
    if (rule.rx.test(relPath)) return true;
    if (rule.anchored) return false;
    // An unanchored pattern matches at any depth.
    const segments = relPath.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (rule.rx.test(segments.slice(i).join('/'))) return true;
    }
    return false;
  };

  return (relPath, isDir) => {
    let ignored = false;
    for (const rule of rules) {
      if (matches(rule, relPath, isDir)) ignored = !rule.negated;
    }
    return ignored;
  };
}

export async function loadGitignore(root: string): Promise<(rel: string, isDir: boolean) => boolean> {
  try {
    const content = await readFile(path.join(root, '.gitignore'), 'utf8');
    return gitignoreMatcher(content.split('\n'));
  } catch {
    return () => false;
  }
}

/** Repo-relative POSIX paths of every file worth looking at. */
export async function walkRepo(root: string, options: WalkOptions = {}): Promise<string[]> {
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const maxBytes = options.maxFileBytes ?? 1_500_000;
  const isIgnored = await loadGitignore(root);
  const out: string[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        if (isIgnored(rel, true)) continue;
        await visit(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (isIgnored(rel, false)) continue;
        try {
          const info = await stat(path.join(root, rel));
          if (!info.isFile() || info.size > maxBytes) continue;
        } catch {
          continue;
        }
        out.push(rel);
      }
    }
  };

  await visit('');
  return out.sort();
}

/**
 * Files git tracks, which in a clean checkout is exactly "what the repository contains".
 *
 * The ignore heuristics below are calibrated for a developer's working tree, where `build/`
 * and `dist/` hold generated junk. A benchmark workspace is a fresh checkout where every file
 * present is tracked, so applying those heuristics there can only lose real source. Asking git
 * removes the guesswork — and the reimplementation of .gitignore — entirely.
 */
export async function listGitTracked(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const files = stdout.split('\0').filter(Boolean);
      resolve(files.length ? files : undefined);
    });
  });
}

/**
 * The repository's files: git's answer when this is a checkout, the walker otherwise.
 * Size and ignore filters still apply to the walker; git's list only gets the size filter.
 */
export async function listRepoFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const tracked = await listGitTracked(root);
  if (!tracked) return walkRepo(root, options);

  const maxBytes = options.maxFileBytes ?? 1_500_000;
  const kept: string[] = [];
  for (const rel of tracked) {
    try {
      const info = await stat(path.join(root, rel));
      if (info.isFile() && info.size <= maxBytes) kept.push(rel);
    } catch {
      /* listed but missing: a broken symlink or a sparse checkout */
    }
  }
  return kept.sort();
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
