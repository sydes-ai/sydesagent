/**
 * Cross-file reference resolution.
 *
 * Resolution is deliberately staged from most to least certain, and the stage that produced
 * an edge determines its confidence. When several same-named candidates survive, we emit at
 * most `maxAmbiguousFanout` heuristic edges and otherwise drop the reference: a reference
 * that could point anywhere is noise, and noise is what makes a graph actively harmful.
 */
import path from 'node:path';
import {
  edgeId,
  fileNodeId,
  symbolNodeId,
  type Confidence,
  type EdgeKind,
  type FileFacts,
  type GraphNode,
} from './model.js';
import type { GraphStore } from './store.js';

export interface ResolveOptions {
  /** How many same-named candidates may become heuristic edges before we give up. */
  maxAmbiguousFanout: number;
}

export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = { maxAmbiguousFanout: 3 };

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function dirOf(relPath: string): string {
  const dir = path.posix.dirname(relPath);
  return dir === '.' ? '' : dir;
}

/** Scope key. Case-sensitive on purpose - see GraphStore.nameIndex. */
function key(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/** Maps a Go import path to a repo-relative directory, or undefined if it is external. */
export function goImportDir(spec: string, goModule: string | undefined): string | undefined {
  if (!goModule) return undefined;
  if (spec === goModule) return '';
  if (spec.startsWith(`${goModule}/`)) return spec.slice(goModule.length + 1);
  return undefined;
}

/**
 * Maps a TS/JS module specifier to a repo file. Handles the ESM convention of importing
 * `./foo.js` from `foo.ts`, directory index files, and tsconfig path aliases.
 */
export function resolveTsImport(
  spec: string,
  fromFile: string,
  fileSet: Set<string>,
  tsPaths: Map<string, string[]>,
): string | undefined {
  const bases: string[] = [];
  if (spec.startsWith('.')) {
    bases.push(path.posix.normalize(path.posix.join(dirOf(fromFile), spec)));
  } else {
    for (const [prefix, targets] of tsPaths) {
      const stem = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
      if (!spec.startsWith(stem)) continue;
      const rest = spec.slice(stem.length);
      for (const target of targets) {
        bases.push(path.posix.normalize(target.endsWith('*') ? target.slice(0, -1) + rest : target));
      }
    }
  }
  if (bases.length === 0) return undefined;

  for (const base of bases) {
    const stems = [base];
    const ext = path.posix.extname(base);
    if (ext && TS_EXTS.includes(ext)) stems.push(base.slice(0, -ext.length));

    for (const stem of stems) {
      if (stem !== base && fileSet.has(stem)) return stem;
      for (const candidate of TS_EXTS.map((e) => stem + e)) {
        if (fileSet.has(candidate)) return candidate;
      }
      for (const candidate of TS_EXTS.map((e) => `${stem}/index${e}`)) {
        if (fileSet.has(candidate)) return candidate;
      }
    }
    if (fileSet.has(base)) return base;
  }
  return undefined;
}

interface Candidate {
  nodes: GraphNode[];
  confidence: Confidence;
}

export function resolveAll(store: GraphStore, opts: ResolveOptions = DEFAULT_RESOLVE_OPTIONS) {
  const started = Date.now();
  store.clearEdges();

  const fileSet = new Set(store.facts.keys());
  const byFileName = new Map<string, GraphNode[]>();
  const byDirName = new Map<string, GraphNode[]>();

  for (const node of store.nodes.values()) {
    if (node.kind === 'file') continue;
    const fk = key(node.file, node.name);
    (byFileName.get(fk) ?? byFileName.set(fk, []).get(fk)!).push(node);
    const dk = key(dirOf(node.file), node.name);
    (byDirName.get(dk) ?? byDirName.set(dk, []).get(dk)!).push(node);
  }

  let unresolved = 0;

  const nodeIdOf = (facts: FileFacts, defIndex: number): string | undefined => {
    const def = facts.defs[defIndex];
    if (!def) return undefined;
    const qualified = def.receiver ? `${def.receiver}.${def.name}` : def.name;
    return symbolNodeId(facts.file, qualified, def.kind);
  };

  const addEdge = (
    from: string,
    to: string,
    kind: EdgeKind,
    confidence: Confidence,
    line?: number,
  ) => {
    store.addEdge({ id: edgeId(from, to, kind, line), from, to, kind, confidence, line });
  };

  for (const facts of store.facts.values()) {
    const fileId = fileNodeId(facts.file);
    const fileDir = dirOf(facts.file);

    // file -> symbol
    facts.defs.forEach((_, i) => {
      const id = nodeIdOf(facts, i);
      if (id) addEdge(fileId, id, 'contains', 'exact');
    });

    // Per-file import bindings.
    const goAliasDir = new Map<string, string>();
    const tsNamespaceFile = new Map<string, string>();
    const tsNamedBinding = new Map<string, { file: string; original: string }>();

    for (const imp of facts.imports) {
      if (facts.lang === 'go') {
        const dir = goImportDir(imp.spec, store.goModule);
        if (dir === undefined) continue;
        if (imp.alias) goAliasDir.set(imp.alias, dir);
        // Import edges point at every file of the imported package.
        for (const other of fileSet) {
          if (dirOf(other) === dir && other !== facts.file) {
            addEdge(fileId, fileNodeId(other), 'imports', 'exact', imp.line);
          }
        }
      } else {
        const target = resolveTsImport(imp.spec, facts.file, fileSet, store.tsPaths);
        if (!target) continue;
        addEdge(fileId, fileNodeId(target), 'imports', 'exact', imp.line);
        if (imp.alias) tsNamespaceFile.set(imp.alias, target);
        for (const [local, original] of Object.entries(imp.names ?? {})) {
          tsNamedBinding.set(local, { file: target, original });
        }
      }
    }

    const lookupFile = (file: string, name: string) => byFileName.get(key(file, name)) ?? [];
    const lookupDir = (dir: string, name: string) => byDirName.get(key(dir, name)) ?? [];

    /** Finds the declaring node of a type name, then a method of that type. */
    const resolveTypedMethod = (typeName: string, method: string): Candidate | undefined => {
      const owners = [
        ...lookupFile(facts.file, typeName),
        ...(facts.lang === 'go' ? lookupDir(fileDir, typeName) : []),
      ];
      if (!owners.length) {
        const binding = tsNamedBinding.get(typeName);
        if (binding) owners.push(...lookupFile(binding.file, binding.original));
      }
      if (!owners.length) {
        const global = store.findByName(typeName).filter((n) => n.kind === 'type' || n.kind === 'interface');
        if (global.length === 1) owners.push(global[0]);
      }
      for (const owner of owners) {
        const methods = store
          .findByName(method, ['method'])
          .filter((n) => n.receiver === owner.name && n.file === owner.file);
        if (methods.length) return { nodes: methods, confidence: 'exact' };
      }
      return undefined;
    };

    /** The staged resolution described at the top of this file. */
    const resolveName = (
      name: string,
      qualifier: string | undefined,
      qualifierType?: string,
    ): Candidate | undefined => {
      // A declared receiver type is the strongest signal available short of a type checker.
      if (qualifierType) {
        const typed = resolveTypedMethod(qualifierType, name);
        if (typed) return typed;
      }
      if (qualifier) {
        if (facts.lang === 'go') {
          const dir = goAliasDir.get(qualifier);
          if (dir !== undefined) {
            const hit = lookupDir(dir, name);
            if (hit.length) return { nodes: hit, confidence: 'exact' };
            return undefined; // known package, symbol not found: do not guess elsewhere
          }
        } else {
          const nsFile = tsNamespaceFile.get(qualifier);
          if (nsFile) {
            const hit = lookupFile(nsFile, name);
            if (hit.length) return { nodes: hit, confidence: 'exact' };
            return undefined;
          }
          const binding = tsNamedBinding.get(qualifier);
          if (binding) {
            // `svc.addPokemon()` where `svc` is not a namespace: fall through to method match.
            const owner = lookupFile(binding.file, binding.original)[0];
            if (owner) {
              const method = store
                .findByName(name, ['method'])
                .filter((n) => n.receiver === owner.name);
              if (method.length) return { nodes: method, confidence: 'exact' };
            }
          }
        }
        // Unqualified fallback for value receivers: match by method name.
        const methods = store.findByName(name, ['method']);
        if (methods.length === 1) return { nodes: methods, confidence: 'likely' };
        if (methods.length > 1) return { nodes: methods, confidence: 'heuristic' };
        return undefined;
      }

      const sameFile = lookupFile(facts.file, name);
      if (sameFile.length) return { nodes: sameFile, confidence: 'exact' };

      if (facts.lang !== 'go') {
        const binding = tsNamedBinding.get(name);
        if (binding) {
          const hit = lookupFile(binding.file, binding.original);
          if (hit.length) return { nodes: hit, confidence: 'exact' };
        }
      } else {
        const samePkg = lookupDir(fileDir, name);
        if (samePkg.length) return { nodes: samePkg, confidence: 'exact' };
      }

      const global = store.findByName(name).filter((n) => n.kind !== 'file');
      if (global.length === 1) return { nodes: global, confidence: 'likely' };
      if (global.length > 1) return { nodes: global, confidence: 'heuristic' };
      return undefined;
    };

    for (const ref of facts.refs) {
      const fromId =
        ref.enclosing !== undefined ? (nodeIdOf(facts, ref.enclosing) ?? fileId) : fileId;
      const resolved = resolveName(ref.name, ref.qualifier, ref.qualifierType);
      if (!resolved) {
        unresolved++;
        continue;
      }
      const targets =
        resolved.confidence === 'heuristic'
          ? resolved.nodes.slice(0, opts.maxAmbiguousFanout)
          : resolved.nodes;
      if (resolved.confidence === 'heuristic' && resolved.nodes.length > opts.maxAmbiguousFanout) {
        unresolved++;
        continue;
      }
      for (const target of targets) {
        const kind: EdgeKind = ref.kind === 'call' ? 'calls' : 'references';
        addEdge(fromId, target.id, kind, resolved.confidence, ref.line);
      }
    }

    // Methods reference their owning type - cheap, and it makes impact analysis honest.
    facts.defs.forEach((def, i) => {
      if (def.kind !== 'method' || !def.receiver) return;
      const from = nodeIdOf(facts, i);
      const owner = lookupFile(facts.file, def.receiver)[0] ?? lookupDir(fileDir, def.receiver)[0];
      if (from && owner) addEdge(from, owner.id, 'references', 'exact', def.startLine);
    });

    // implements / extends
    facts.defs.forEach((def, i) => {
      const from = nodeIdOf(facts, i);
      if (!from) return;
      for (const name of def.implementsNames ?? []) {
        const resolved = resolveName(name, undefined);
        if (!resolved) continue;
        for (const target of resolved.nodes.slice(0, opts.maxAmbiguousFanout)) {
          addEdge(from, target.id, 'implements', resolved.confidence, def.startLine);
        }
      }
    });

    // Test name affinity: `Test_AddPokemon` -> `AddPokemon`, even when the call is indirect.
    if (facts.isTest) {
      facts.defs.forEach((def, i) => {
        if (def.kind !== 'test') return;
        const stem = def.name.replace(/^(Test|Benchmark|Fuzz|Example)_?/, '').split('_')[0];
        if (!stem) return;
        const from = nodeIdOf(facts, i);
        if (!from) return;
        // Name affinity prefers same-package targets: `Test_AddPokemon` in service/ means
        // service.AddPokemon, not a similarly named handler in another package.
        const local = lookupDir(fileDir, stem).filter((n) => !store.facts.get(n.file)?.isTest);
        const candidates = local.length
          ? local
          : store.findByName(stem).filter((n) => n.kind !== 'file' && !store.facts.get(n.file)?.isTest);
        if (candidates.length && candidates.length <= opts.maxAmbiguousFanout) {
          const confidence: Confidence = candidates.length === 1 ? 'exact' : 'heuristic';
          for (const target of candidates) addEdge(from, target.id, 'tests', confidence, def.startLine);
        }
      });
    }
  }

  // Calls originating in a test file are test coverage, whatever their shape.
  for (const edge of [...store.edges.values()]) {
    if (edge.kind !== 'calls') continue;
    const from = store.nodes.get(edge.from);
    const to = store.nodes.get(edge.to);
    if (!from || !to) continue;
    if (!store.facts.get(from.file)?.isTest) continue;
    if (store.facts.get(to.file)?.isTest) continue;
    addEdge(edge.from, edge.to, 'tests', edge.confidence, edge.line);
  }

  store.stats.unresolvedRefs = unresolved;
  store.stats.resolveMs = Date.now() - started;
  store.recomputeStats();
  return { unresolved };
}
