/**
 * Symbol grounding: identifiers a change introduces that refer to nothing real.
 *
 * This is decidable, unlike most of what an agent gets wrong. The graph knows every symbol in
 * the repository, so an edit that calls a function which does not exist can be caught in
 * microseconds — no model call, no test run. We watched a live run "change
 * `maxAllowedPokemonPower` from 1000 to 500" and report success against a symbol that never
 * existed; this turns that silent wrong answer into a correction.
 *
 * The whole design problem is false positives: a validator that cries wolf is worse than none.
 * Four things keep it quiet:
 *
 *  1. Locally bound names (parameters, locals, destructured bindings) are skipped - they are
 *     deliberately not graph nodes.
 *  2. Names bound by an import we could not resolve (an external package) are skipped, since
 *     we have no idea what that package contains.
 *  3. Resolution is read off the edges the resolver actually produced, so this can never
 *     disagree with the graph itself.
 *  4. Callers compare against a pre-edit snapshot, so only *newly introduced* unknowns are
 *     reported and a file's pre-existing noise never surfaces.
 */
import path from 'node:path';
import type { GraphNode } from './model.js';
import { symbolNodeId } from './model.js';
import { goImportDir, resolveTsImport } from './resolve.js';
import type { GraphStore } from './store.js';

export interface UnknownSymbol {
  name: string;
  qualifier?: string;
  line: number;
  /** `not-in-package` is the stronger signal: the package exists, the symbol does not. */
  reason: 'not-found' | 'not-in-package';
  /** Closest existing symbols, for a "did you mean" that points at real code. */
  candidates: GraphNode[];
}

function key(symbol: UnknownSymbol): string {
  return `${symbol.qualifier ?? ''}.${symbol.name}`;
}

/** Local names introduced by imports whose module we could not resolve. */
function externalBindings(store: GraphStore, file: string): Set<string> {
  const facts = store.facts.get(file);
  const out = new Set<string>();
  if (!facts) return out;
  const fileSet = new Set(store.facts.keys());

  for (const imp of facts.imports) {
    const local =
      facts.lang === 'go'
        ? goImportDir(imp.spec, store.goModule) !== undefined
        : resolveTsImport(imp.spec, file, fileSet, store.tsPaths) !== undefined;
    if (local) continue;
    if (imp.alias) out.add(imp.alias);
    for (const name of Object.keys(imp.names ?? {})) out.add(name);
  }
  return out;
}

/**
 * References in `file` that resolved to nothing. Read from the edges the resolver produced
 * rather than re-deriving resolution, so the two can never drift apart.
 */
export function unknownSymbols(store: GraphStore, file: string, maxCandidates = 3): UnknownSymbol[] {
  const facts = store.facts.get(file);
  if (!facts) return [];

  const locals = new Set(facts.locals);
  const external = externalBindings(store, file);
  const fileId = `file:${file}`;
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);

  const nodeIdOf = (defIndex: number): string => {
    const def = facts.defs[defIndex];
    if (!def) return fileId;
    const qualified = def.receiver ? `${def.receiver}.${def.name}` : def.name;
    return symbolNodeId(file, qualified, def.kind);
  };

  const out: UnknownSymbol[] = [];
  const seen = new Set<string>();

  for (const ref of facts.refs) {
    if (locals.has(ref.name)) continue;
    if (ref.qualifier && (locals.has(ref.qualifier) || external.has(ref.qualifier))) continue;
    if (!ref.qualifier && external.has(ref.name)) continue;

    const fromId = ref.enclosing !== undefined ? nodeIdOf(ref.enclosing) : fileId;
    // If the resolver produced an edge for this reference, it resolved. Matching on line and
    // target name biases toward false negatives, which is the safe direction here.
    const resolved = store
      .outgoing(fromId)
      .some((edge) => edge.line === ref.line && store.nodes.get(edge.to)?.name === ref.name);
    if (resolved) continue;

    // Does the name exist anywhere at all? If so, this is our resolution falling short, not a
    // symbol the model invented - unless it was qualified by a package we *can* see.
    const anywhere = store.findByName(ref.name).filter((node) => node.kind !== 'file');

    // A qualifier we can see: a package or namespace this repository actually contains.
    const qualifierIsKnownPackage = ref.qualifier
      ? facts.lang === 'go'
        ? facts.imports.some(
            (imp) => imp.alias === ref.qualifier && goImportDir(imp.spec, store.goModule) !== undefined,
          )
        : facts.imports.some((imp) => imp.alias === ref.qualifier)
      : false;

    // `x.foo()` where x is a value: without type inference we do not know what x is, so we
    // cannot say whether `foo` exists. Every `json.NewDecoder(b).Decode()`, `mu.Lock()` and
    // `expect(...).toBe(...)` lands here, and judging them would make the check useless noise.
    if (ref.member && !qualifierIsKnownPackage) continue;

    let reason: UnknownSymbol['reason'] | undefined;
    if (ref.qualifier) {
      if (qualifierIsKnownPackage) reason = 'not-in-package';
    } else if (!anywhere.length) {
      // Unqualified and unknown everywhere. Same-package definitions would have resolved.
      const samePackage = store
        .findByName(ref.name)
        .some((node) => (path.posix.dirname(node.file) === dir ? true : false));
      if (!samePackage) reason = 'not-found';
    }
    if (!reason) continue;

    const id = key({ name: ref.name, qualifier: ref.qualifier, line: 0, reason, candidates: [] });
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      name: ref.name,
      qualifier: ref.qualifier,
      line: ref.line,
      reason,
      candidates: anywhere.slice(0, maxCandidates),
    });
  }

  return out;
}

/** Unknowns present after an edit that were not there before it. */
export function newUnknowns(before: UnknownSymbol[], after: UnknownSymbol[]): UnknownSymbol[] {
  const known = new Set(before.map(key));
  return after.filter((symbol) => !known.has(key(symbol)));
}

export function formatUnknowns(file: string, unknowns: UnknownSymbol[], query?: {
  suggest(name: string): GraphNode[];
}): string {
  if (!unknowns.length) return '';
  const lines = [`This edit references ${unknowns.length} symbol(s) that do not exist:`];
  for (const symbol of unknowns) {
    const label = symbol.qualifier ? `${symbol.qualifier}.${symbol.name}` : symbol.name;
    const where = symbol.reason === 'not-in-package'
      ? `no such symbol in package "${symbol.qualifier}"`
      : 'not defined anywhere in this repository';
    lines.push(`  ${file}:${symbol.line}  ${label} — ${where}`);

    const candidates = symbol.candidates.length ? symbol.candidates : (query?.suggest(symbol.name) ?? []);
    for (const candidate of candidates.slice(0, 3)) {
      const name = candidate.receiver ? `${candidate.receiver}.${candidate.name}` : candidate.name;
      lines.push(`      did you mean ${name} → ${candidate.file}:${candidate.startLine}`);
    }
  }
  return lines.join('\n');
}
