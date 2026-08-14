/**
 * Grammar loading. WASM grammars only - see docs/decisions.md D1. Grammars are cached
 * process-wide because loading one costs tens of milliseconds and the indexer touches
 * thousands of files.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, type Tree } from 'web-tree-sitter';
import type { Lang } from './model.js';

const require = createRequire(import.meta.url);

/** Grammar file name per language (tsx and typescript are separate grammars). */
const WASM_BY_LANG: Record<Lang, string> = {
  go: 'tree-sitter-go.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

let initialized: Promise<void> | undefined;
const languageCache = new Map<Lang, Promise<Language>>();
const parserCache = new Map<Lang, Parser>();

function wasmDir(): string {
  return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
}

async function ensureInit(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

async function loadLanguage(lang: Lang): Promise<Language> {
  let cached = languageCache.get(lang);
  if (!cached) {
    cached = (async () => {
      await ensureInit();
      const bytes = await readFile(path.join(wasmDir(), WASM_BY_LANG[lang]));
      return Language.load(bytes);
    })();
    languageCache.set(lang, cached);
  }
  return cached;
}

export async function getParser(lang: Lang): Promise<Parser> {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

export async function parseSource(lang: Lang, source: string): Promise<Tree> {
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${lang}`);
  return tree;
}
