/**
 * The graph model, kept deliberately small. Every node kind and edge kind has to earn its
 * place: the graph exists to answer a handful of navigation questions cheaply, not to be a
 * complete semantic model of the language.
 */

export type Lang = 'go' | 'typescript' | 'javascript' | 'tsx';

export type NodeKind =
  | 'file'
  | 'package'
  | 'function'
  | 'method'
  | 'type'
  | 'interface'
  | 'const'
  | 'test';

export type EdgeKind =
  | 'contains' // file  -> symbol
  | 'imports' // file  -> file
  | 'calls' // symbol -> symbol
  | 'references' // symbol -> type/const
  | 'implements' // type   -> interface
  | 'tests'; // test   -> symbol

/**
 * How much we trust an edge.
 *
 * - `exact`     resolved through an explicit binding (import, same package, same file scope)
 * - `likely`    resolved by a repo-unique name match
 * - `heuristic` one of several same-named candidates; may be wrong
 *
 * Ranking prefers higher confidence and heuristic edges are labelled when shown to the model.
 * A confidently wrong edge is worse than a missing one: it sends the agent into the wrong
 * subsystem, which is the exact failure mode the design set out to avoid.
 */
export type Confidence = 'exact' | 'likely' | 'heuristic';

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 3,
  likely: 2,
  heuristic: 1,
};

/**
 * How strongly a change propagates along each edge kind.
 *
 * This is a different question from `CONFIDENCE_RANK`, and using that one for both was a
 * mistake worth naming. Confidence asks "is this edge real?" — a resolver's uncertainty about
 * whether `foo()` means the `foo` we think. Propagation asks "if the far end changes, must
 * this end change too?" A perfectly resolved call into a logging helper is `exact` and
 * propagates almost nothing; a `likely` edge into a shared interface propagates hard. Ranking
 * needs the second quantity and was reading the first.
 *
 * The ordering is the one the type system dictates. Adding a method to an interface breaks
 * every implementer — the compiler will say so. A test names the symbol it covers, so it
 * follows that symbol's signature. Imports bind a module's exported surface. A call breaks
 * only when arity or types move. A bare name in a body usually survives untouched.
 */
export const PROPAGATION: Record<EdgeKind, number> = {
  implements: 1,
  tests: 0.8,
  contains: 0.6,
  imports: 0.5,
  calls: 0.4,
  references: 0.25,
};

/** Uncertainty as a discount on propagation, rather than a substitute for it. */
export const CONFIDENCE_FACTOR: Record<Confidence, number> = {
  exact: 1,
  likely: 0.7,
  heuristic: 0.4,
};

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Simple name, e.g. `addPokemon`. */
  name: string;
  /** Disambiguated name, e.g. `Handler.Routes` or `service.AddPokemon`. */
  qualified: string;
  /** Repo-relative POSIX path. */
  file: string;
  lang: Lang;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Go receiver type / TS class name for methods. */
  receiver?: string;
  /** Go package name or TS module dir. */
  pkg?: string;
  signature?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  /** 1-based line of the call/reference site in the `from` file. */
  line?: number;
}

export function fileNodeId(relPath: string): string {
  return `file:${relPath}`;
}

export function symbolNodeId(relPath: string, qualified: string, kind: NodeKind): string {
  return `sym:${relPath}#${qualified}:${kind}`;
}

export function edgeId(from: string, to: string, kind: EdgeKind, line?: number): string {
  return `${kind}|${from}|${to}|${line ?? 0}`;
}

export function isSymbolKind(kind: NodeKind): boolean {
  return kind !== 'file' && kind !== 'package';
}

/** A symbol reference discovered in a file, before resolution. */
export interface RefFact {
  /** Callee simple name, e.g. `DecodePokemonJSON`. */
  name: string;
  /** Package alias or receiver expression text, e.g. `helpers` in `helpers.Decode...`. */
  qualifier?: string;
  /**
   * Declared type of the qualifier when the source states it (`svc: PokemonService`,
   * `private repo: PokemonRepo`). Turns a name-matched guess into an exact resolution.
   */
  qualifierType?: string;
  line: number;
  kind: 'call' | 'reference';
  /**
   * True when the reference came through a selector/member expression (`x.foo()`).
   * Without type inference the receiver of such a call is unknown, so the symbol validator
   * must not judge it unless the qualifier is a package we actually index.
   */
  member?: boolean;
  /** Index into `FileFacts.defs` of the enclosing definition, if any. */
  enclosing?: number;
}

export interface DefFact {
  name: string;
  kind: NodeKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  receiver?: string;
  signature?: string;
  /** Type names this definition declares it implements or extends (TS). */
  implementsNames?: string[];
}

export interface ImportFact {
  /** Raw module specifier / Go import path. */
  spec: string;
  /** Local binding for the whole module (Go package name or alias, TS namespace import). */
  alias?: string;
  /** Named bindings: local name -> original exported name. */
  names?: Record<string, string>;
  line: number;
}

/** Everything one file contributes to the graph, before cross-file resolution. */
export interface FileFacts {
  file: string;
  lang: Lang;
  /** Go package name; TS module directory. */
  pkg?: string;
  isTest: boolean;
  defs: DefFact[];
  refs: RefFact[];
  imports: ImportFact[];
  /**
   * Every name bound somewhere in this file: parameters, local variables, destructured
   * bindings, loop variables. These are not graph nodes - they would flood it - but the
   * symbol validator needs them, or it reports every local helper as an unknown symbol.
   */
  locals: string[];
  contentHash: string;
  lineCount: number;
}
