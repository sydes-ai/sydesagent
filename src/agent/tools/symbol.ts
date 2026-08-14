import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { formatEnvelope } from '../../graph/outline.js';
import type { Tool, ToolResult } from './types.js';
import { numberLines, resolveInRoot } from './util.js';

/**
 * The change envelope: one retrieval that carries what several file reads would.
 *
 * Reading a whole file to change one function is the single most expensive habit an agent
 * has - a 1200-line file is ~12k tokens, and every later turn re-sends it. Reading one symbol
 * at a time is not the fix either: turns are the multiplier, so three small reads cost more
 * than one large one. This returns the symbol in full plus the contract boundary around it -
 * the file's skeleton and the signatures one hop out - so a single call is usually enough to
 * make a correct edit.
 */
export const readSymbolTool: Tool<{ anchor: string }> = {
  name: 'read_symbol',
  description:
    'Read one symbol with the context needed to change it: its full source, an outline of the rest of its file, and the signatures of what it calls and what calls it. Prefer this over read_file when you already know which symbol you need — it is far cheaper than reading the whole file.',
  parameters: {
    type: 'object',
    properties: {
      anchor: {
        type: 'string',
        description: 'Symbol name, Type.method, or path/to/file.go#symbol',
      },
    },
    required: ['anchor'],
  },
  schema: z.object({ anchor: z.string() }),
  graphOnly: true,

  async run(args, ctx): Promise<ToolResult> {
    const started = Date.now();
    const parts = ctx.graph.envelope(args.anchor);

    if (!parts) {
      // No guessing: fall back to the same concrete alternatives an unknown anchor gets.
      const expansion = ctx.graph.expand(args.anchor);
      return { content: expansion.text, isError: true, note: 'envelope-miss' };
    }

    const node = parts.node;
    let source = '';
    try {
      const { abs } = resolveInRoot(ctx.root, node.file);
      const lines = (await readFile(abs, 'utf8')).split('\n');
      source = numberLines(lines.slice(node.startLine - 1, node.endLine).join('\n'), node.startLine);
    } catch (error) {
      return { content: `Cannot read ${node.file}: ${(error as Error).message}`, isError: true };
    }

    const surfaced = [
      ...new Set([node.file, ...parts.calls.map((n) => n.file), ...parts.calledBy.map((n) => n.file)]),
    ];
    ctx.trace.emit({
      type: 'graph_lookup',
      turn: ctx.turn,
      kind: 'envelope',
      anchor: args.anchor,
      ms: Date.now() - started,
      results: parts.calls.length + parts.calledBy.length,
      surfaced,
    });
    const fresh = ctx.ledger.noteSurfaced(surfaced, 'graph', ctx.turn);
    if (fresh.length) {
      ctx.trace.emit({ type: 'suggestion_surfaced', turn: ctx.turn, paths: fresh, source: 'graph' });
    }
    // The envelope shows the symbol in full, so a later full-file read is not a repeat.
    ctx.ledger.expansions.add(node.file);

    return { content: formatEnvelope(parts, source) };
  },
};
