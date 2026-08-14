import type { Node, Tree } from 'web-tree-sitter';
import type { DefFact, ImportFact, Lang, RefFact } from '../model.js';

export interface ExtractResult {
  pkg?: string;
  defs: DefFact[];
  refs: RefFact[];
  imports: ImportFact[];
  /** Locally bound names - see FileFacts.locals. */
  locals?: string[];
}

/** Collects every `identifier` under a binding pattern (destructuring included). */
export function bindingNames(node: Node | null, out: Set<string>): void {
  if (!node) return;
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (
      current.type === 'identifier' ||
      current.type === 'shorthand_property_identifier_pattern' ||
      // Generic parameter names (`Tool<A>`) are type_identifiers, and are bindings too.
      current.type === 'type_identifier'
    ) {
      out.add(current.text);
    }
    for (let i = 0; i < current.namedChildCount; i++) stack.push(current.namedChild(i)!);
  }
}

export interface LanguageAdapter {
  id: Lang;
  /** File extensions this adapter claims, including the dot. */
  extensions: string[];
  isTestFile(relPath: string): boolean;
  extract(tree: Tree, source: string, relPath: string): ExtractResult;
}

/** 1-based line of a node's start. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** First line of a declaration, trimmed - enough for the model to see the shape. */
export function signatureOf(node: Node, source: string, maxLen = 160): string {
  const text = source.slice(node.startIndex, node.endIndex);
  const firstLine = text.split('\n', 1)[0].trim();
  const cut = firstLine.replace(/\s*\{\s*$/, '');
  return cut.length > maxLen ? `${cut.slice(0, maxLen - 1)}…` : cut;
}
