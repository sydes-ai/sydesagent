/**
 * Rendering. Graph answers are always navigational: every line ends in a path the agent can
 * open. A list of bare symbol names would just create another round of searching, which is
 * the cost this project exists to remove.
 */
import { padRight } from '../util/text.js';
import type { GraphNode } from './model.js';
import type { Group, Neighborhood, RelatedItem } from './query.js';

function label(node: GraphNode): string {
  if (node.kind === 'file') return node.file;
  return node.receiver ? `${node.receiver}.${node.name}` : node.name;
}

function location(node: GraphNode): string {
  return node.kind === 'file' ? node.file : `${node.file}:${node.startLine}`;
}

export function formatItem(item: RelatedItem, width: number): string {
  const marker = item.confidence === 'heuristic' ? '  ~uncertain' : '';
  return `  ${padRight(label(item.node), width)} → ${location(item.node)}${marker}`;
}

export function formatGroups(groups: Group[]): string {
  const lines: string[] = [];
  for (const group of groups) {
    const width = Math.min(40, Math.max(...group.items.map((i) => label(i.node).length), 0));
    lines.push(`${group.label}:`);
    for (const item of group.items) lines.push(formatItem(item, width));
    if (group.truncated > 0) lines.push(`  … +${group.truncated} more`);
  }
  return lines.join('\n');
}

export function formatNeighborhood(n: Neighborhood): string {
  const header =
    n.anchor.kind === 'file'
      ? `Structure of ${n.anchor.file}`
      : `Structure around ${label(n.anchor)} (${location(n.anchor)})`;
  const body = formatGroups(n.groups);
  return body ? `${header}\n${body}` : `${header}\n  (no structural relationships found)`;
}

export function formatNodes(title: string, nodes: GraphNode[]): string {
  if (!nodes.length) return `${title}: none`;
  const width = Math.min(40, Math.max(...nodes.map((n) => label(n).length)));
  const lines = nodes.map(
    (n) => `  ${padRight(label(n), width)} → ${location(n)}${n.signature ? `    ${n.signature}` : ''}`,
  );
  return `${title}:\n${lines.join('\n')}`;
}

export function formatPathCandidates(badPath: string, candidates: { file: string }[]): string {
  if (!candidates.length) return '';
  const lines = candidates.map((c) => `  ${c.file}`);
  return `Existing nearby structural candidates for "${badPath}":\n${lines.join('\n')}`;
}
