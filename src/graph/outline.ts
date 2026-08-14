/**
 * Outlines and change envelopes: using structure to send *less* code, not more.
 *
 * Every other use of the graph in this project is additive - it appends relationships to
 * something the model was already going to read. This is the substitutive one. A 1200-line
 * file costs ~12k tokens and is re-sent on every subsequent turn; its outline costs a few
 * hundred and preserves what the model actually needs to navigate.
 *
 * The unit matters as much as the idea. Whole-file reads mean few retrievals of huge payloads;
 * single-symbol reads mean small payloads but many retrievals - and since every turn re-sends
 * the whole conversation, trading bytes for turns loses. The envelope is sized in between: the
 * target symbol in full, the file's skeleton, and the signatures one hop out, so a single call
 * carries what three file reads would.
 */
import type { GraphNode } from './model.js';
import { GraphQuery } from './query.js';
import type { GraphStore } from './store.js';

function label(node: GraphNode): string {
  return node.receiver ? `${node.receiver}.${node.name}` : node.name;
}

function line(node: GraphNode): string {
  const signature = node.signature ?? label(node);
  return `  ${String(node.startLine).padStart(5)}  ${signature}`;
}

/**
 * A file's shape: what it declares, where. Enough to navigate and to decide what to open,
 * without the bodies.
 */
export function fileOutline(store: GraphStore, file: string): string {
  const facts = store.facts.get(file);
  if (!facts) return '';

  const symbols = store
    .symbolsInFile(file)
    .sort((a, b) => a.startLine - b.startLine);
  if (!symbols.length) return '';

  const header = `${file} (${facts.lineCount} lines${facts.pkg ? `, package ${facts.pkg}` : ''}, ${symbols.length} symbols)`;
  const imports = facts.imports.length
    ? `  imports: ${facts.imports.map((i) => i.spec).slice(0, 12).join(', ')}${facts.imports.length > 12 ? ` … +${facts.imports.length - 12}` : ''}`
    : '';

  return [header, imports, ...symbols.map(line)].filter(Boolean).join('\n');
}

export interface EnvelopeParts {
  node: GraphNode;
  outline: string;
  /** Signatures of what the symbol calls, one hop out. */
  calls: GraphNode[];
  /** Signatures of what calls it. */
  calledBy: GraphNode[];
  tests: GraphNode[];
}

/**
 * The change envelope: everything needed to edit one symbol correctly, in one retrieval.
 *
 * The caller splices in the symbol's own source - the graph supplies the contract boundary
 * around it.
 */
export function envelopeFor(store: GraphStore, anchor: string): EnvelopeParts | undefined {
  const query = new GraphQuery(store);
  const resolution = query.resolveAnchor(anchor);
  if (!resolution.node || resolution.node.kind === 'file') return undefined;

  const node = resolution.node;
  const unique = (nodes: GraphNode[]) => {
    const seen = new Map<string, GraphNode>();
    for (const item of nodes) if (!seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
  };

  return {
    node,
    outline: fileOutline(store, node.file),
    calls: unique(query.callees(node.id).map((i) => i.node)).slice(0, 12),
    calledBy: unique(
      query.callers(node.id).filter((i) => !store.facts.get(i.node.file)?.isTest).map((i) => i.node),
    ).slice(0, 12),
    tests: unique(query.testsFor(node.id).map((i) => i.node)).slice(0, 6),
  };
}

/** Renders the structural half of an envelope; the source of the symbol goes in between. */
export function formatEnvelope(parts: EnvelopeParts, source: string): string {
  const sections: string[] = [];
  const node = parts.node;

  sections.push(`Change envelope for ${label(node)} (${node.file}:${node.startLine}-${node.endLine})`);

  if (parts.outline) sections.push(`\n--- file skeleton ---\n${parts.outline}`);
  sections.push(`\n--- ${label(node)} (full source) ---\n${source}`);

  const listing = (title: string, nodes: GraphNode[]) => {
    if (!nodes.length) return;
    const rows = nodes.map((n) => `  ${n.signature ?? label(n)}  → ${n.file}:${n.startLine}`);
    sections.push(`\n--- ${title} ---\n${rows.join('\n')}`);
  };

  listing('calls (signatures only)', parts.calls);
  listing('called by', parts.calledBy);
  listing('covered by tests', parts.tests);

  return sections.join('\n');
}
