/**
 * Multi-SWE-bench dataset loading.
 *
 * Field names follow the harness's own `PullRequest` model: org, repo, number, base.sha,
 * resolved_issues, fix_patch, test_patch. `fix_patch` and `test_patch` are the answer key and
 * must never reach the agent - only the issue text does.
 */
import { readFile } from 'node:fs/promises';

export interface ResolvedIssue {
  number: number;
  title: string;
  body?: string | null;
}

export interface BenchInstance {
  org: string;
  repo: string;
  number: number | string;
  base: { label?: string; ref?: string; sha: string };
  title?: string;
  body?: string | null;
  resolved_issues?: ResolvedIssue[];
  /** Reference patches - held back from the agent, used only for scoring. */
  fix_patch?: string;
  test_patch?: string;
  lang?: string;
  hints?: string;
  /**
   * Non-standard escape hatch: clone from here instead of github.com. Lets a sweep run
   * against a local mirror or an air-gapped copy, and makes the benchmark path testable
   * without network access.
   */
  repo_url?: string;
}

export interface DatasetFilter {
  langs?: string[];
  repos?: string[];
  ids?: string[];
  limit?: number;
}

export function instanceId(instance: BenchInstance): string {
  return `${instance.org}__${instance.repo}-${instance.number}`;
}

export function repoUrl(instance: BenchInstance): string {
  return instance.repo_url ?? `https://github.com/${instance.org}/${instance.repo}.git`;
}

/** The problem statement, assembled the way the benchmark intends. */
export function taskText(instance: BenchInstance): string {
  const parts: string[] = [];
  if (instance.title) parts.push(`# ${instance.title}`);
  if (instance.body) parts.push(instance.body);
  for (const issue of instance.resolved_issues ?? []) {
    parts.push(`## Linked issue #${issue.number}: ${issue.title}`);
    if (issue.body) parts.push(issue.body);
  }
  const text = parts.join('\n\n').trim();
  return text || `Resolve pull request ${instanceId(instance)} in ${instance.org}/${instance.repo}.`;
}

function matches(instance: BenchInstance, filter: DatasetFilter): boolean {
  if (filter.langs?.length && !filter.langs.includes((instance.lang ?? '').toLowerCase())) return false;
  if (filter.repos?.length && !filter.repos.includes(`${instance.org}/${instance.repo}`)) return false;
  if (filter.ids?.length && !filter.ids.includes(instanceId(instance))) return false;
  return true;
}

export async function loadDataset(
  files: string[],
  filter: DatasetFilter = {},
): Promise<BenchInstance[]> {
  const out: BenchInstance[] = [];
  let malformed = 0;

  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let instance: BenchInstance;
      try {
        instance = JSON.parse(trimmed) as BenchInstance;
      } catch {
        // These files run to hundreds of megabytes and a truncated download leaves one bad
        // line. Refusing to start over a single unparseable record helps nobody; skip it and
        // report the count so a corrupt file is still visible.
        malformed++;
        continue;
      }
      if (!instance.org || !instance.repo || instance.number === undefined) {
        throw new Error(`${file}: instance is missing org/repo/number`);
      }
      if (!matches(instance, filter)) continue;
      out.push(instance);
      if (filter.limit && out.length >= filter.limit) return out;
    }
  }
  if (malformed) {
    console.error(`[dataset] skipped ${malformed} unparseable line(s)`);
  }
  return out;
}
