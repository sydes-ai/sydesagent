import path from 'node:path';
import type { Lang } from '../model.js';
import { goAdapter } from './go.js';
import { javascriptAdapter, tsxAdapter, typescriptAdapter } from './typescript.js';
import type { LanguageAdapter } from './types.js';

export const ADAPTERS: LanguageAdapter[] = [
  goAdapter,
  typescriptAdapter,
  tsxAdapter,
  javascriptAdapter,
];

const BY_EXT = new Map<string, LanguageAdapter>();
for (const adapter of ADAPTERS) {
  for (const ext of adapter.extensions) BY_EXT.set(ext, adapter);
}

export function adapterFor(
  relPath: string,
  options: { allowDeclarations?: boolean } = {},
): LanguageAdapter | undefined {
  // A `.d.ts` duplicates the symbols of its implementation, so it is excluded by default.
  // The indexer admits the standalone ones, where no implementation exists to duplicate.
  if (relPath.endsWith('.d.ts') && !options.allowDeclarations) return undefined;
  return BY_EXT.get(path.posix.extname(relPath));
}

export function langOf(relPath: string): Lang | undefined {
  return adapterFor(relPath)?.id;
}
