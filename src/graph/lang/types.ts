import type { Node, Tree } from 'web-tree-sitter';
import type { DefFact, ImportFact, Lang, RefFact } from '../model.js';

export interface ExtractResult {
  pkg?: string;
  defs: DefFact[];
  refs: RefFact[];
  imports: ImportFact[];
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
