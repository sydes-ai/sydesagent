/**
 * Enrichment middleware: the places where structural knowledge is delivered *without* costing
 * an extra model turn.
 *
 * A tool result is something the model is already paying to read. Attaching the structural
 * consequence of that result there - the neighborhood of a file it just opened, the real
 * files near a path it guessed wrong - is what turns the graph from an extra layer into a
 * replacement for a round of search-and-read. Everything here is deduped against the ledger
 * and hard-capped, because an enrichment that repeats known facts is pure cost.
 */
import { formatGroups } from '../graph/format.js';
import type { Group } from '../graph/query.js';
import type { ToolContext } from './tools/types.js';

function trimToLines(text: string, maxLines: number): { text: string; truncated: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: 0 };
  return { text: lines.slice(0, maxLines).join('\n'), truncated: lines.length - maxLines };
}

/** Drops facts already shown, then renders what is left. */
function renderFresh(groups: Group[], ctx: ToolContext): { text: string; suppressed: number } {
  const fresh: Group[] = [];
  let suppressed = 0;
  for (const group of groups) {
    const filtered = ctx.ledger.unseenFacts(group.label, group.items, (item) => item.node.id);
    suppressed += filtered.suppressed;
    if (!filtered.fresh.length) continue;
    fresh.push({ ...group, items: filtered.fresh });
  }
  for (const group of fresh) {
    ctx.ledger.markFactsShown(group.label, group.items, (item) => item.node.id);
  }
  return { text: fresh.length ? formatGroups(fresh) : '', suppressed };
}

function recordSurfaced(ctx: ToolContext, paths: string[]): void {
  const fresh = ctx.ledger.noteSurfaced(paths, 'graph', ctx.turn);
  if (fresh.length) {
    ctx.trace.emit({ type: 'suggestion_surfaced', turn: ctx.turn, paths: fresh, source: 'graph' });
  }
}

/** E1 - structural footer after a successful read. */
export function enrichRead(relPath: string, ctx: ToolContext): string {
  if (!ctx.config.enrichment.readFooter || !ctx.graph.enabled) return '';
  if (ctx.ledger.expansions.has(relPath)) return '';

  const result = ctx.graph.expand(relPath);
  ctx.trace.emit({
    type: 'graph_lookup',
    turn: ctx.turn,
    kind: 'expand:auto',
    anchor: relPath,
    ms: result.ms,
    results: result.count,
    surfaced: result.surfacedFiles,
  });
  if (!result.groups?.length) return '';

  ctx.ledger.expansions.add(relPath);
  const { text, suppressed } = renderFresh(
    // "Defined here" duplicates the file the model just read in full.
    result.groups.filter((g) => g.label !== 'Defined here'),
    ctx,
  );
  if (!text) {
    ctx.trace.emit({ type: 'enrichment', turn: ctx.turn, kind: 'read_footer', bytes: 0, suppressed: true });
    return '';
  }

  const trimmed = trimToLines(text, ctx.config.enrichment.maxFooterLines);
  const body =
    `\n\n--- structure (from the code graph, not the file) ---\n${trimmed.text}` +
    (trimmed.truncated ? `\n  … +${trimmed.truncated} more (graph_expand for the rest)` : '') +
    (suppressed ? `\n  (${suppressed} relationship(s) already shown earlier)` : '');

  recordSurfaced(ctx, result.surfacedFiles);
  ctx.trace.emit({
    type: 'enrichment',
    turn: ctx.turn,
    kind: 'read_footer',
    bytes: body.length,
    suppressed: false,
  });
  return body;
}

/** E2 - a wrong path guess becomes the real neighbours, with no extra model turn. */
export function enrichFailedRead(relPath: string, ctx: ToolContext): string {
  if (!ctx.config.enrichment.failedReadRecovery || !ctx.graph.enabled) return '';
  const result = ctx.graph.pathCandidates(relPath);
  ctx.trace.emit({
    type: 'graph_lookup',
    turn: ctx.turn,
    kind: 'path_candidates',
    anchor: relPath,
    ms: result.ms,
    results: result.count,
    surfaced: result.surfacedFiles,
  });
  if (!result.text) return '';

  recordSurfaced(ctx, result.surfacedFiles);
  ctx.trace.emit({
    type: 'enrichment',
    turn: ctx.turn,
    kind: 'failed_read',
    bytes: result.text.length,
    suppressed: false,
  });
  return `\n${result.text}`;
}

/** E3 - a search that found nothing gets structural alternatives instead of a dead end. */
export function enrichEmptySearch(term: string, ctx: ToolContext): string {
  if (!ctx.config.enrichment.emptySearchHints || !ctx.graph.enabled) return '';
  const result = ctx.graph.symbolCandidates(term);
  ctx.trace.emit({
    type: 'graph_lookup',
    turn: ctx.turn,
    kind: 'symbol_candidates',
    anchor: term,
    ms: result.ms,
    results: result.count,
    surfaced: result.surfacedFiles,
  });
  if (!result.text) return '';

  recordSurfaced(ctx, result.surfacedFiles);
  ctx.trace.emit({
    type: 'enrichment',
    turn: ctx.turn,
    kind: 'empty_search',
    bytes: result.text.length,
    suppressed: false,
  });
  return `\n${result.text}`;
}

/** E4 - after an edit, what else the change reaches, and which tests cover it. */
export function enrichPostEdit(ctx: ToolContext): string {
  if (!ctx.config.enrichment.postEditImpact || !ctx.graph.enabled) return '';
  const edited = ctx.ledger.editedFiles();
  if (!edited.length) return '';

  const result = ctx.graph.impact(edited);
  ctx.trace.emit({
    type: 'graph_lookup',
    turn: ctx.turn,
    kind: 'impact:auto',
    anchor: edited.join(','),
    ms: result.ms,
    results: result.count,
    surfaced: result.surfacedFiles,
  });
  if (!result.groups?.length) return '';

  const { text, suppressed } = renderFresh(result.groups, ctx);
  if (!text) {
    ctx.trace.emit({ type: 'enrichment', turn: ctx.turn, kind: 'post_edit', bytes: 0, suppressed: true });
    return '';
  }

  const trimmed = trimToLines(text, ctx.config.enrichment.maxFooterLines);
  const body =
    `\n\n--- change surface (from the code graph) ---\n${trimmed.text}` +
    (trimmed.truncated ? `\n  … +${trimmed.truncated} more (graph_impact for the rest)` : '') +
    (suppressed ? `\n  (${suppressed} relationship(s) already shown earlier)` : '');

  recordSurfaced(ctx, result.surfacedFiles);
  ctx.trace.emit({
    type: 'enrichment',
    turn: ctx.turn,
    kind: 'post_edit',
    bytes: body.length,
    suppressed: false,
  });
  return body;
}
