import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hashContent } from '../../util/fs.js';
import type { UnknownSymbol } from '../../graph/validate.js';
import { enrichFailedRead, enrichPostEdit, enrichRead, enrichSymbolCheck } from '../enrich.js';
import { runCompile } from '../verify.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { countLines, numberLines, resolveInRoot } from './util.js';

/**
 * Everything that runs after a file changes, in cost order: the graph re-index and the free
 * symbol check first, then the compiler.
 *
 * The compiler runs in both arms - the graph's contribution is narrowing it to the packages
 * the change actually reaches, which is what the experiment measures. When it fails the
 * result is returned immediately and marked as an error, because a broken build is the most
 * actionable feedback available and costs no model reasoning to produce.
 */
async function afterEdit(
  ctx: ToolContext,
  rel: string,
  unknownsBefore: UnknownSymbol[],
): Promise<string> {
  await ctx.graph.noteEdit([rel]);

  const symbols = enrichSymbolCheck(rel, unknownsBefore, ctx);
  const impact = enrichPostEdit(ctx);

  let compile = '';
  if (ctx.config.compileAfterEdit) {
    const result = await runCompile(
      ctx.root,
      ctx.ledger.editedFiles(),
      ctx.graph,
      ctx.exec,
      ctx.config.compileTimeoutMs,
    );
    if (result) {
      ctx.trace.emit({
        type: 'compile_check',
        turn: ctx.turn,
        command: result.plan.command,
        scoped: result.plan.scoped,
        ok: result.ok,
        ms: result.ms,
      });
      compile = result.ok
        ? `\n\n--- build ok (${result.plan.command}, ${result.ms}ms) ---`
        : `\n\n--- build FAILED (${result.plan.command}) ---\n${result.output}`;
    }
  }

  return `${symbols}${impact}${compile}`;
}

function recordAccess(ctx: ToolContext, rel: string, kind: 'read' | 'edit'): void {
  const attribution = ctx.ledger.attribute(rel);
  ctx.trace.emit({
    type: 'path_access',
    turn: ctx.turn,
    pathName: rel,
    kind,
    attributedSource: attribution.attributedSource,
    firstSurfacedTurn: attribution.firstSurfacedTurn,
  });
}

export const readFileTool: Tool<{ path: string; start_line?: number; end_line?: number }> = {
  name: 'read_file',
  description:
    'Read a file from the repository. Returns numbered lines. Use start_line/end_line for a slice of a large file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative path' },
      start_line: { type: 'integer', description: 'First line to return (1-based)' },
      end_line: { type: 'integer', description: 'Last line to return (inclusive)' },
    },
    required: ['path'],
  },
  schema: z.object({
    path: z.string(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }),

  async run(args, ctx): Promise<ToolResult> {
    let rel: string;
    let abs: string;
    try {
      ({ abs, rel } = resolveInRoot(ctx.root, args.path));
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }

    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      ctx.ledger.noteFailedRead(rel, ctx.turn);
      const recovery = enrichFailedRead(rel, ctx);
      ctx.trace.emit({
        type: 'failed_read',
        turn: ctx.turn,
        pathName: rel,
        recovered: recovery.length > 0,
        candidates: recovery ? ctx.graph.pathCandidates(rel).surfacedFiles : [],
      });
      return {
        content: `File not found: ${rel}${recovery}`,
        isError: true,
        note: recovery ? 'recovered' : 'not-recovered',
      };
    }

    const hash = hashContent(content);
    const isRepeat = ctx.ledger.hasFreshRead(rel, hash);
    const wantsSlice = args.start_line !== undefined || args.end_line !== undefined;

    if (isRepeat && !wantsSlice) {
      const record = ctx.ledger.noteRead(rel, hash, countLines(content), ctx.turn);
      ctx.trace.emit({
        type: 'repeat_read',
        turn: ctx.turn,
        pathName: rel,
        firstTurn: record.firstTurn,
        unchanged: true,
      });
      recordAccess(ctx, rel, 'read');
      // The content is already in the conversation; re-sending it would cost attention for
      // nothing. Point at it instead.
      return {
        content: `${rel} is unchanged since you read it on turn ${record.firstTurn} (${record.lines} lines). Its contents are already above. Re-read a slice with start_line/end_line if you need to look again.`,
        note: 'repeat-read-stubbed',
      };
    }

    const lines = content.split('\n');
    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? start + ctx.config.maxReadLines - 1);
    const slice = lines.slice(start - 1, end);
    const truncated = end < lines.length || start > 1;

    ctx.ledger.noteRead(rel, hash, lines.length, ctx.turn);
    recordAccess(ctx, rel, 'read');

    // A file too long to send would otherwise be cut at an arbitrary line, which costs a lot
    // of tokens *and* hides most of the file. An outline is strictly better on both counts:
    // fewer tokens, and it shows what is actually there. Only substitutes where the read was
    // going to be truncated anyway, so nothing complete is ever withheld.
    if (!wantsSlice && lines.length > ctx.config.maxReadLines) {
      const outline = ctx.graph.outline(rel);
      if (outline) {
        ctx.ledger.expansions.add(rel);
        return {
          content:
            `${rel} is ${lines.length} lines — too long to send in full, so here is its structure.\n` +
            `Use read_symbol <name> for one symbol with its context, or read_file with ` +
            `start_line/end_line for a specific region.\n\n${outline}`,
          note: 'outline',
        };
      }
    }

    const header = truncated
      ? `${rel} (lines ${start}-${end} of ${lines.length})`
      : `${rel} (${lines.length} lines)`;
    const footer = wantsSlice ? '' : enrichRead(rel, ctx);

    return { content: `${header}\n${numberLines(slice.join('\n'), start)}${footer}` };
  },
};

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description: 'List the entries of a directory in the repository.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Repository-relative directory' } },
  },
  schema: z.object({ path: z.string().optional() }),

  async run(args, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInRoot(ctx.root, args.path ?? '.');
      const entries = await readdir(abs, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith('.git'))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return { content: `${rel || '.'}:\n${lines.map((l) => `  ${l}`).join('\n')}` };
    } catch (error) {
      return { content: `Cannot list "${args.path}": ${(error as Error).message}`, isError: true };
    }
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create a file or replace its entire contents.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({ path: z.string(), content: z.string() }),

  async run(args, ctx): Promise<ToolResult> {
    let rel: string;
    let abs: string;
    try {
      ({ abs, rel } = resolveInRoot(ctx.root, args.path));
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }

    let previous = '';
    try {
      previous = await readFile(abs, 'utf8');
    } catch {
      /* new file */
    }
    // Snapshot before the write so only newly introduced unknowns are reported.
    const unknownsBefore = ctx.graph.unknownSymbols(rel);

    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, args.content);

    const record = {
      path: rel,
      turn: ctx.turn,
      kind: 'write' as const,
      addedLines: countLines(args.content),
      removedLines: countLines(previous),
    };
    ctx.ledger.noteEdit(record);
    ctx.trace.emit({
      type: 'edit',
      turn: ctx.turn,
      pathName: rel,
      kind: 'write',
      addedLines: record.addedLines,
      removedLines: record.removedLines,
    });
    recordAccess(ctx, rel, 'edit');

    const followUp = await afterEdit(ctx, rel, unknownsBefore);
    return { content: `Wrote ${rel} (${record.addedLines} lines).${followUp}` };
  },
};

export const editFileTool: Tool<{
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, including indentation' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  schema: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),

  async run(args, ctx): Promise<ToolResult> {
    let rel: string;
    let abs: string;
    try {
      ({ abs, rel } = resolveInRoot(ctx.root, args.path));
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }

    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      const recovery = enrichFailedRead(rel, ctx);
      return { content: `File not found: ${rel}${recovery}`, isError: true };
    }

    const unknownsBefore = ctx.graph.unknownSymbols(rel);
    const occurrences = content.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return {
        content: `old_string not found in ${rel}. Read the file again and copy the exact text, including indentation.`,
        isError: true,
      };
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        content: `old_string appears ${occurrences} times in ${rel}. Add more surrounding context to make it unique, or set replace_all.`,
        isError: true,
      };
    }

    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    await writeFile(abs, updated);

    const record = {
      path: rel,
      turn: ctx.turn,
      kind: 'edit' as const,
      addedLines: countLines(args.new_string),
      removedLines: countLines(args.old_string),
    };
    ctx.ledger.noteEdit(record);
    ctx.trace.emit({
      type: 'edit',
      turn: ctx.turn,
      pathName: rel,
      kind: 'edit',
      addedLines: record.addedLines,
      removedLines: record.removedLines,
    });
    recordAccess(ctx, rel, 'edit');

    const followUp = await afterEdit(ctx, rel, unknownsBefore);
    return {
      content: `Edited ${rel} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).${followUp}`,
    };
  },
};
