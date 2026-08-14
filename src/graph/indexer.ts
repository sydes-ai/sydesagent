import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashContent, walkRepo } from '../util/fs.js';
import { adapterFor } from './lang/registry.js';
import { fileNodeId, symbolNodeId, type FileFacts, type GraphNode } from './model.js';
import { parseSource } from './parser.js';
import { DEFAULT_RESOLVE_OPTIONS, resolveAll, type ResolveOptions } from './resolve.js';
import { GraphStore } from './store.js';

export interface IndexOptions {
  resolve?: ResolveOptions;
  maxFileBytes?: number;
}

async function readGoModule(root: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(root, 'go.mod'), 'utf8');
    return /^module\s+(\S+)/m.exec(content)?.[1];
  } catch {
    return undefined;
  }
}

async function readTsPaths(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const raw = await readFile(path.join(root, 'tsconfig.json'), 'utf8');
    // tsconfig allows comments and trailing commas; strip the common cases.
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const config = JSON.parse(cleaned.replace(/,(\s*[}\]])/g, '$1'));
    const baseUrl: string = config?.compilerOptions?.baseUrl ?? '.';
    const paths: Record<string, string[]> = config?.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths)) {
      out.set(
        alias,
        targets.map((t) => path.posix.normalize(path.posix.join(baseUrl, t))),
      );
    }
  } catch {
    /* no tsconfig, or unparseable - alias resolution is a bonus, not a requirement */
  }
  return out;
}

/** Parses one file into facts plus its nodes, and installs both in the store. */
export async function indexFile(
  store: GraphStore,
  relPath: string,
  content: string,
): Promise<FileFacts | undefined> {
  const adapter = adapterFor(relPath);
  if (!adapter) return undefined;

  const tree = await parseSource(adapter.id, content);
  try {
    const extracted = adapter.extract(tree, content, relPath);
    const facts: FileFacts = {
      file: relPath,
      lang: adapter.id,
      pkg: extracted.pkg ?? path.posix.dirname(relPath),
      isTest: adapter.isTestFile(relPath),
      defs: extracted.defs,
      refs: extracted.refs,
      imports: extracted.imports,
      locals: extracted.locals ?? [],
      contentHash: hashContent(content),
      lineCount: content.split('\n').length,
    };

    store.removeFile(relPath);
    store.facts.set(relPath, facts);

    const fileNode: GraphNode = {
      id: fileNodeId(relPath),
      kind: 'file',
      name: path.posix.basename(relPath),
      qualified: relPath,
      file: relPath,
      lang: adapter.id,
      startLine: 1,
      endLine: facts.lineCount,
      exported: true,
      pkg: facts.pkg,
    };
    store.addNode(fileNode);

    for (const def of facts.defs) {
      const qualified = def.receiver ? `${def.receiver}.${def.name}` : def.name;
      store.addNode({
        id: symbolNodeId(relPath, qualified, def.kind),
        kind: def.kind,
        name: def.name,
        qualified,
        file: relPath,
        lang: adapter.id,
        startLine: def.startLine,
        endLine: def.endLine,
        exported: def.exported,
        receiver: def.receiver,
        pkg: facts.pkg,
        signature: def.signature,
      });
    }
    return facts;
  } finally {
    tree.delete();
  }
}

export async function indexRepo(root: string, options: IndexOptions = {}): Promise<GraphStore> {
  const started = Date.now();
  const store = new GraphStore(root);
  store.goModule = await readGoModule(root);
  store.tsPaths = await readTsPaths(root);

  const files = await walkRepo(root, { maxFileBytes: options.maxFileBytes });
  for (const rel of files) {
    if (!adapterFor(rel)) continue;
    try {
      const content = await readFile(path.join(root, rel), 'utf8');
      await indexFile(store, rel, content);
    } catch {
      /* unreadable or binary file - skip, the graph is best-effort by design */
    }
  }

  store.stats.indexMs = Date.now() - started;
  resolveAll(store, options.resolve ?? DEFAULT_RESOLVE_OPTIONS);
  return store;
}

/**
 * Re-indexes specific files after an edit and rebuilds edges.
 *
 * Resolution is redone globally rather than scoped: it is a few map lookups per reference,
 * so a full pass costs milliseconds on fixture-sized repos and stays correct when an edit
 * adds a symbol that some previously-unresolved reference elsewhere now matches. The cost is
 * recorded in `stats.resolveMs` so a real repo can prove or disprove that assumption.
 */
export async function reindexFiles(
  store: GraphStore,
  relPaths: string[],
  options: IndexOptions = {},
): Promise<void> {
  for (const rel of relPaths) {
    if (!adapterFor(rel)) continue;
    try {
      const content = await readFile(path.join(store.root, rel), 'utf8');
      await indexFile(store, rel, content);
    } catch {
      store.removeFile(rel); // deleted file
    }
  }
  resolveAll(store, options.resolve ?? DEFAULT_RESOLVE_OPTIONS);
}
