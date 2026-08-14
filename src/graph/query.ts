/**
 * The entire surface the agent sees. Everything returns ranked, budgeted results: an
 * unbounded neighborhood is just a repository map by another name, and dumping one into the
 * context is the failure mode this design exists to avoid.
 */
import path from 'node:path';
import { trigramSimilarity } from '../util/text.js';
import {
  CONFIDENCE_RANK,
  type Confidence,
  type EdgeKind,
  type GraphNode,
  type NodeKind,
} from './model.js';
import type { GraphStore } from './store.js';

export interface RelatedItem {
  node: GraphNode;
  via: EdgeKind;
  confidence: Confidence;
  /** Line of the call/reference site in the *anchor's* file, when known. */
  line?: number;
}

export interface Group {
  label: string;
  items: RelatedItem[];
  truncated: number;
}

export interface Neighborhood {
  anchor: GraphNode;
  groups: Group[];
  /** Every distinct file surfaced, for suggestion attribution. */
  surfacedFiles: string[];
}

export interface NeighborOptions {
  perGroup?: number;
  maxGroups?: number;
  includeHeuristic?: boolean;
}

export interface AnchorResolution {
  status: 'file' | 'symbol' | 'ambiguous' | 'notfound';
  node?: GraphNode;
  candidates: GraphNode[];
}

const KIND_PRIORITY: Record<NodeKind, number> = {
  function: 6,
  method: 6,
  test: 5,
  type: 4,
  interface: 4,
  const: 2,
  file: 1,
  package: 0,
};

function rank(a: RelatedItem, b: RelatedItem): number {
  const conf = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (conf) return conf;
  const kind = KIND_PRIORITY[b.node.kind] - KIND_PRIORITY[a.node.kind];
  if (kind) return kind;
  if (a.node.file !== b.node.file) return a.node.file.localeCompare(b.node.file);
  return a.node.startLine - b.node.startLine;
}

function dedupe(items: RelatedItem[]): RelatedItem[] {
  const seen = new Map<string, RelatedItem>();
  for (const item of items) {
    const prior = seen.get(item.node.id);
    if (!prior || CONFIDENCE_RANK[item.confidence] > CONFIDENCE_RANK[prior.confidence]) {
      seen.set(item.node.id, item);
    }
  }
  return [...seen.values()];
}

export class GraphQuery {
  constructor(readonly store: GraphStore) {}

  /**
   * Accepts `path/to/file.go`, `path/to/file.go:42`, `path/to/file.go#symbol`, `Type.method`
   * or a bare symbol name. Refuses to guess: an unresolvable anchor comes back as `notfound`
   * with path candidates, never as a plausible-looking wrong subsystem.
   */
  resolveAnchor(input: string): AnchorResolution {
    const raw = input.trim();

    const hashed = raw.split('#');
    if (hashed.length === 2) {
      const [file, symbol] = hashed;
      const matches = this.store
        .symbolsInFile(file)
        .filter((n) => n.name === symbol || n.qualified === symbol);
      if (matches.length === 1) return { status: 'symbol', node: matches[0], candidates: matches };
      if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
    }

    const withLine = /^(.*):(\d+)$/.exec(raw);
    if (withLine && this.store.fileNode(withLine[1])) {
      const file = withLine[1];
      const at = this.store.symbolAt(file, Number(withLine[2]));
      if (at) return { status: 'symbol', node: at, candidates: [at] };
      const fileNode = this.store.fileNode(file)!;
      return { status: 'file', node: fileNode, candidates: [fileNode] };
    }

    const fileNode = this.store.fileNode(raw);
    if (fileNode) return { status: 'file', node: fileNode, candidates: [fileNode] };

    const dotted = raw.split('.');
    const byQualified = [...this.store.nodes.values()].filter(
      (n) => n.kind !== 'file' && n.qualified === raw,
    );
    if (byQualified.length === 1) return { status: 'symbol', node: byQualified[0], candidates: byQualified };

    const byName = this.store.findByName(dotted.length === 2 ? dotted[1] : raw).filter(
      (n) => n.kind !== 'file' && (dotted.length !== 2 || n.receiver === dotted[0]),
    );
    if (byName.length === 1) return { status: 'symbol', node: byName[0], candidates: byName };
    if (byName.length > 1) {
      // A test named after the code it exercises (`describe('addPokemonHandler')`) must not
      // shadow that code when the agent asks to expand the name.
      const production = byName.filter((n) => n.kind !== 'test' && !this.store.facts.get(n.file)?.isTest);
      if (production.length === 1) return { status: 'symbol', node: production[0], candidates: byName };
      return { status: 'ambiguous', candidates: byName };
    }

    return { status: 'notfound', candidates: [] };
  }

  findSymbol(name: string, kinds?: NodeKind[]): GraphNode[] {
    const exact = this.store.findByName(name, kinds).filter((n) => n.kind !== 'file');
    if (exact.length) return exact;
    const caseInsensitive = this.store.findByName(name, kinds, true).filter((n) => n.kind !== 'file');
    if (caseInsensitive.length) return caseInsensitive;
    // Fall back to fuzzy name match so a near-miss guess still lands somewhere real.
    const scored = [...this.store.nodes.values()]
      .filter((n) => n.kind !== 'file' && (!kinds || kinds.includes(n.kind)))
      .map((node) => ({ node, score: trigramSimilarity(name, node.name) }))
      .filter((x) => x.score > 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    return scored.map((x) => x.node);
  }

  private related(nodeId: string, direction: 'out' | 'in', kinds: EdgeKind[]): RelatedItem[] {
    const edges =
      direction === 'out' ? this.store.outgoing(nodeId) : this.store.incoming(nodeId);
    const items: RelatedItem[] = [];
    for (const edge of edges) {
      if (!kinds.includes(edge.kind)) continue;
      const other = this.store.nodes.get(direction === 'out' ? edge.to : edge.from);
      if (!other) continue;
      items.push({ node: other, via: edge.kind, confidence: edge.confidence, line: edge.line });
    }
    return dedupe(items);
  }

  callers(nodeId: string): RelatedItem[] {
    return this.related(nodeId, 'in', ['calls']).sort(rank);
  }

  callees(nodeId: string): RelatedItem[] {
    return this.related(nodeId, 'out', ['calls']).sort(rank);
  }

  /**
   * Tests that exercise a symbol: explicit `tests` edges plus any call originating in a test
   * file. Both paths matter - naming conventions catch indirect coverage, call edges catch
   * tests that exercise a symbol through a helper.
   */
  testsFor(nodeId: string): RelatedItem[] {
    const viaEdges = this.related(nodeId, 'in', ['tests']);
    const viaCalls = this.related(nodeId, 'in', ['calls']).filter(
      (item) => this.store.facts.get(item.node.file)?.isTest,
    );
    return dedupe([...viaEdges, ...viaCalls]).sort(rank);
  }

  implementations(nodeId: string): RelatedItem[] {
    return this.related(nodeId, 'in', ['implements']).sort(rank);
  }

  /**
   * File-aware relation lookup. Relationships attach to symbols, but "which tests cover this
   * file?" is the question an agent actually asks, so a file anchor aggregates over the
   * symbols it defines.
   */
  relationOf(node: GraphNode, kind: 'callers' | 'callees' | 'tests'): RelatedItem[] {
    const pick = (id: string) =>
      kind === 'callers' ? this.callers(id) : kind === 'callees' ? this.callees(id) : this.testsFor(id);

    if (node.kind !== 'file') return pick(node.id);

    const contained = this.store.symbolsInFile(node.file);
    const items = contained.flatMap((symbol) => pick(symbol.id));
    return dedupe(items.filter((item) => item.node.file !== node.file)).sort(rank);
  }

  /**
   * The structural neighborhood of an anchor - the operation the agent leans on after it
   * finds a concrete piece of code.
   */
  neighbors(anchor: GraphNode, options: NeighborOptions = {}): Neighborhood {
    const perGroup = options.perGroup ?? 8;
    const includeHeuristic = options.includeHeuristic ?? true;
    const groups: Group[] = [];

    const push = (label: string, items: RelatedItem[]) => {
      let filtered = items.filter((i) => includeHeuristic || i.confidence !== 'heuristic');
      filtered = filtered.filter((i) => i.node.id !== anchor.id);
      if (!filtered.length) return;
      groups.push({
        label,
        items: filtered.slice(0, perGroup),
        truncated: Math.max(0, filtered.length - perGroup),
      });
    };

    if (anchor.kind === 'file') {
      const contained = this.related(anchor.id, 'out', ['contains'])
        .filter((i) => i.node.kind !== 'test')
        .sort(rank);
      push('Defined here', contained);

      // Aggregate the neighborhood of everything the file defines: this is what makes one
      // expansion of a handler file surface its helpers, services and tests at once.
      const outward: RelatedItem[] = [];
      const inward: RelatedItem[] = [];
      const tests: RelatedItem[] = [];
      for (const item of contained) {
        outward.push(...this.callees(item.node.id).filter((c) => c.node.file !== anchor.file));
        inward.push(...this.callers(item.node.id).filter((c) => c.node.file !== anchor.file));
        tests.push(...this.testsFor(item.node.id));
      }
      push('Related code', dedupe(outward).sort(rank));
      push('Used by', dedupe(inward.filter((i) => !this.store.facts.get(i.node.file)?.isTest)).sort(rank));
      push('Related tests', dedupe(tests).sort(rank));
    } else {
      push('Calls', this.callees(anchor.id));
      push('Called by', this.callers(anchor.id).filter((i) => !this.store.facts.get(i.node.file)?.isTest));
      push('Uses types', this.related(anchor.id, 'out', ['references']).sort(rank));
      push('Implementations', this.implementations(anchor.id));
      push('Related tests', this.testsFor(anchor.id));
    }

    const surfacedFiles = [
      ...new Set(groups.flatMap((g) => g.items.map((i) => i.node.file)).filter((f) => f !== anchor.file)),
    ];
    return { anchor, groups, surfacedFiles };
  }

  /**
   * The change surface of an edit: who calls the changed symbols, what they implement, and
   * which tests reach them. This is the "what else should be checked" question the model
   * otherwise has to reconstruct by hand.
   */
  impact(changedFiles: string[], options: NeighborOptions = {}): {
    changed: GraphNode[];
    groups: Group[];
    testFiles: string[];
  } {
    const perGroup = options.perGroup ?? 12;
    const changed = changedFiles.flatMap((f) => this.store.symbolsInFile(f));

    const directCallers: RelatedItem[] = [];
    const transitive: RelatedItem[] = [];
    const tests: RelatedItem[] = [];
    const implementers: RelatedItem[] = [];

    const changedIds = new Set(changed.map((n) => n.id));
    for (const node of changed) {
      for (const caller of this.callers(node.id)) {
        if (this.store.facts.get(caller.node.file)?.isTest) continue;
        if (changedIds.has(caller.node.id)) continue;
        directCallers.push(caller);
        for (const second of this.callers(caller.node.id)) {
          if (changedIds.has(second.node.id)) continue;
          if (this.store.facts.get(second.node.file)?.isTest) continue;
          transitive.push(second);
        }
      }
      tests.push(...this.testsFor(node.id));
      implementers.push(...this.implementations(node.id));
    }

    const groups: Group[] = [];
    const push = (label: string, items: RelatedItem[]) => {
      const unique = dedupe(items).sort(rank);
      if (!unique.length) return;
      groups.push({
        label,
        items: unique.slice(0, perGroup),
        truncated: Math.max(0, unique.length - perGroup),
      });
    };

    push('Direct callers', directCallers);
    push('Indirect callers', transitive.filter((t) => !directCallers.some((d) => d.node.id === t.node.id)));
    push('Implementations', implementers);
    push('Tests covering the change', tests);

    const testFiles = [...new Set(dedupe(tests).map((t) => t.node.file))];
    return { changed, groups, testFiles };
  }

  /**
   * Recovery for a path the model guessed wrong. Scores every known file against the guess
   * so `server/handler/pokemon.go` comes back with `pkg/handler/pokedex.go`.
   */
  pathCandidates(badPath: string, limit = 5): { file: string; score: number }[] {
    const guessBase = path.posix.basename(badPath);
    const guessStem = guessBase.replace(/\.[^.]+$/, '');
    const guessExt = path.posix.extname(badPath);
    const guessSegments = badPath.split('/').filter(Boolean);

    const scored = this.store.files().map((file) => {
      const base = path.posix.basename(file);
      const stem = base.replace(/\.[^.]+$/, '');
      let score = trigramSimilarity(guessStem, stem) * 2;
      if (path.posix.extname(file) === guessExt) score += 0.4;

      const segments = file.split('/').filter(Boolean);
      const shared = segments.filter((s) => guessSegments.includes(s)).length;
      score += shared * 0.5;

      // A trailing-path match ("handler/pokemon.go" vs ".../handler/pokedex.go") is a strong
      // signal that the model had the right subsystem and the wrong file name.
      // Weighted above basename similarity on purpose: a wrong guess usually has the right
      // subsystem and the wrong file name, not the other way round.
      if (segments.length > 1 && guessSegments.length > 1) {
        if (segments[segments.length - 2] === guessSegments[guessSegments.length - 2]) score += 1.2;
      }
      return { file, score };
    });

    return scored
      .filter((s) => s.score > 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Symbols whose name is close to a failed search term. */
  symbolCandidates(term: string, limit = 6): GraphNode[] {
    return this.findSymbol(term).slice(0, limit);
  }
}
