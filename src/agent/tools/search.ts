import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { walkRepo } from '../../util/fs.js';
import { enrichEmptySearch } from '../enrich.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/** Cached file listing per workspace: a grep should not re-walk the tree every time. */
const listings = new Map<string, { files: string[]; at: number }>();

async function repoFiles(ctx: ToolContext): Promise<string[]> {
  const cached = listings.get(ctx.root);
  if (cached && Date.now() - cached.at < 30_000) return cached.files;
  const files = await walkRepo(ctx.root);
  listings.set(ctx.root, { files, at: Date.now() });
  return files;
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

export const grepTool: Tool<{ pattern: string; glob?: string; path?: string; max_results?: number }> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching path:line: text. Optionally restrict with a glob or a subdirectory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      glob: { type: 'string', description: 'Restrict to matching paths, e.g. "**/*.go"' },
      path: { type: 'string', description: 'Restrict to a subdirectory' },
      max_results: { type: 'integer' },
    },
    required: ['pattern'],
  },
  schema: z.object({
    pattern: z.string(),
    glob: z.string().optional(),
    path: z.string().optional(),
    max_results: z.number().int().positive().optional(),
  }),

  async run(args, ctx): Promise<ToolResult> {
    ctx.ledger.noteSearch(args.pattern);

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, 'g');
    } catch (error) {
      return { content: `Invalid regular expression: ${(error as Error).message}`, isError: true };
    }

    const limit = args.max_results ?? ctx.config.maxGrepResults;
    const globRe = args.glob ? globToRegExp(args.glob) : undefined;
    const prefix = args.path ? args.path.replace(/^\.\//, '').replace(/\/$/, '') : undefined;

    const files = await repoFiles(ctx);
    const hits: string[] = [];
    const matchedFiles = new Set<string>();
    let scanned = 0;

    for (const file of files) {
      if (prefix && !file.startsWith(`${prefix}/`) && file !== prefix) continue;
      if (globRe && !globRe.test(file)) continue;
      let content: string;
      try {
        content = await readFile(path.join(ctx.root, file), 'utf8');
      } catch {
        continue;
      }
      scanned++;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        matchedFiles.add(file);
        hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }

    if (!hits.length) {
      // A dead-end search is the cheapest possible moment to offer a structural alternative.
      const hint = enrichEmptySearch(args.pattern.replace(/[^\w]/g, ''), ctx);
      return {
        content: `No matches for /${args.pattern}/ in ${scanned} files.${hint}`,
        note: hint ? 'empty-search-hinted' : 'empty-search',
      };
    }

    const fresh = ctx.ledger.noteSurfaced([...matchedFiles], 'search', ctx.turn);
    if (fresh.length) {
      ctx.trace.emit({ type: 'suggestion_surfaced', turn: ctx.turn, paths: fresh, source: 'search' });
    }

    const more = hits.length >= limit ? `\n… stopped at ${limit} matches` : '';
    return { content: `${hits.length} match(es) for /${args.pattern}/:\n${hits.join('\n')}${more}` };
  },
};

export const globTool: Tool<{ pattern: string }> = {
  name: 'glob',
  description: 'List repository files matching a glob, e.g. "**/*_test.go".',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
  },
  schema: z.object({ pattern: z.string() }),

  async run(args, ctx): Promise<ToolResult> {
    const regex = globToRegExp(args.pattern);
    const files = (await repoFiles(ctx)).filter((f) => regex.test(f));
    if (!files.length) return { content: `No files match ${args.pattern}` };

    const shown = files.slice(0, 100);
    const fresh = ctx.ledger.noteSurfaced(shown, 'search', ctx.turn);
    if (fresh.length) {
      ctx.trace.emit({ type: 'suggestion_surfaced', turn: ctx.turn, paths: fresh, source: 'search' });
    }
    const more = files.length > shown.length ? `\n… +${files.length - shown.length} more` : '';
    return { content: `${files.length} file(s):\n${shown.join('\n')}${more}` };
  },
};
