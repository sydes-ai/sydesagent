/**
 * The explicit graph tools.
 *
 * All of them take a *concrete* anchor - a path or a symbol that exists in the code. There is
 * deliberately no "ask the graph about the task in English" tool: natural-language retrieval
 * over a structural index is exactly where a graph becomes confidently wrong, sending the
 * agent into a subsystem that merely sounds right. The model finds an anchor; the graph
 * expands from it.
 */
import { z } from 'zod';
import type { GraphResult } from '../../graph/provider.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

function report(ctx: ToolContext, kind: string, anchor: string, result: GraphResult): ToolResult {
  ctx.trace.emit({
    type: 'graph_lookup',
    turn: ctx.turn,
    kind,
    anchor,
    ms: result.ms,
    results: result.count,
    surfaced: result.surfacedFiles,
  });
  const fresh = ctx.ledger.noteSurfaced(result.surfacedFiles, 'graph', ctx.turn);
  if (fresh.length) {
    ctx.trace.emit({ type: 'suggestion_surfaced', turn: ctx.turn, paths: fresh, source: 'graph' });
  }
  if (result.groups?.length) {
    for (const group of result.groups) {
      ctx.ledger.markFactsShown(group.label, group.items, (item) => item.node.id);
    }
  }
  return { content: result.text || 'The graph has nothing for that anchor.' };
}

export const graphExpandTool: Tool<{ anchor: string }> = {
  name: 'graph_expand',
  description:
    'Show the structural neighborhood of a file or symbol that exists in the code: what it calls, what calls it, and which tests cover it, each with a path. Use it once you have a concrete anchor instead of searching for the same relationships.',
  parameters: {
    type: 'object',
    properties: {
      anchor: {
        type: 'string',
        description: 'A repository path (pkg/handler/pokedex.go), a symbol (addPokemon), or path#symbol',
      },
    },
    required: ['anchor'],
  },
  schema: z.object({ anchor: z.string() }),
  graphOnly: true,

  async run(args, ctx) {
    ctx.ledger.expansions.add(args.anchor);
    return report(ctx, 'expand', args.anchor, ctx.graph.expand(args.anchor));
  },
};

export const graphFindTool: Tool<{ name: string }> = {
  name: 'graph_find',
  description: 'Locate a symbol by name and get its definition path, line and signature.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  schema: z.object({ name: z.string() }),
  graphOnly: true,

  async run(args, ctx) {
    return report(ctx, 'find', args.name, ctx.graph.find(args.name));
  },
};

export const graphCallersTool: Tool<{ anchor: string }> = {
  name: 'graph_callers',
  description: 'List everything that calls a symbol, with paths.',
  parameters: {
    type: 'object',
    properties: { anchor: { type: 'string' } },
    required: ['anchor'],
  },
  schema: z.object({ anchor: z.string() }),
  graphOnly: true,

  async run(args, ctx) {
    return report(ctx, 'callers', args.anchor, ctx.graph.callers(args.anchor));
  },
};

export const graphCalleesTool: Tool<{ anchor: string }> = {
  name: 'graph_callees',
  description: 'List everything a symbol calls, with paths.',
  parameters: {
    type: 'object',
    properties: { anchor: { type: 'string' } },
    required: ['anchor'],
  },
  schema: z.object({ anchor: z.string() }),
  graphOnly: true,

  async run(args, ctx) {
    return report(ctx, 'callees', args.anchor, ctx.graph.callees(args.anchor));
  },
};

export const graphTestsTool: Tool<{ anchor: string }> = {
  name: 'graph_tests_for',
  description: 'List the tests that exercise a file or symbol, with paths.',
  parameters: {
    type: 'object',
    properties: { anchor: { type: 'string' } },
    required: ['anchor'],
  },
  schema: z.object({ anchor: z.string() }),
  graphOnly: true,

  async run(args, ctx) {
    return report(ctx, 'tests_for', args.anchor, ctx.graph.testsFor(args.anchor));
  },
};

export const graphImpactTool: Tool<Record<string, never>> = {
  name: 'graph_impact',
  description:
    'Show what your edits so far structurally affect: callers, implementations and the tests that cover them. Use it before deciding what to verify.',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}).passthrough() as unknown as z.ZodType<Record<string, never>>,
  graphOnly: true,

  async run(_args, ctx) {
    const edited = ctx.ledger.editedFiles();
    if (!edited.length) {
      return { content: 'No files edited yet, so there is no change surface to report.' };
    }
    return report(ctx, 'impact', edited.join(','), ctx.graph.impact(edited));
  },
};

export const GRAPH_TOOLS = [
  graphExpandTool,
  graphFindTool,
  graphCallersTool,
  graphCalleesTool,
  graphTestsTool,
  graphImpactTool,
];
