import path from 'node:path';
import { toPosix } from '../../util/fs.js';

/** Resolves a model-supplied path inside the workspace, refusing to escape it. */
export function resolveInRoot(root: string, candidate: string): { abs: string; rel: string } {
  const cleaned = candidate.trim().replace(/^\.\//, '');
  const abs = path.resolve(root, cleaned);
  const rel = toPosix(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${candidate}" is outside the workspace`);
  }
  return { abs, rel };
}

export function numberLines(content: string, startLine = 1): string {
  return content
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(5)}  ${line}`)
    .join('\n');
}

export function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

/** Paths mentioned anywhere in a blob of text that actually exist in the repo. */
export function pathsMentioned(text: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[\w./-]+\.[A-Za-z][\w]{0,4}/g)) {
    const candidate = match[0].replace(/^\.\//, '');
    if (known.has(candidate)) out.add(candidate);
  }
  return [...out];
}
