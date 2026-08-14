/**
 * `GraphProvider` is the seam between the agent and the structural layer. The agent depends
 * on this interface only, so an external indexer (for example codebase-memory-mcp) can be
 * substituted without touching the loop, and so the whole layer can be switched off for the
 * graph-off baseline that the experiment compares against.
 */
import path from 'node:path';
import { formatGroups, formatNeighborhood, formatNodes, formatPathCandidates } from './format.js';
import { indexRepo, reindexFiles } from './indexer.js';
import type { GraphNode } from './model.js';
import { GraphQuery, type Group } from './query.js';
import type { GraphStats, GraphStore } from './store.js';

export interface GraphResult {
  /** Rendered, navigational text ready to hand to the model. */
  text: string;
  /**
   * Structured form of the same answer. The enrichment layer needs it to drop facts the
   * model has already been shown before rendering, rather than re-parsing its own output.
   */
  groups?: Group[];
  /** Files this answer surfaced, recorded for suggestion→access attribution. */
  surfacedFiles: string[];
  /** Number of related items returned, for the lookup metrics. */
  count: number;
  ms: number;
}

export interface GraphProvider {
  readonly enabled: boolean;
  readonly stats: GraphStats;
  index(): Promise<void>;
  expand(anchor: string, opts?: { perGroup?: number }): GraphResult;
  find(name: string): GraphResult;
  callers(anchor: string): GraphResult;
  callees(anchor: string): GraphResult;
  testsFor(anchor: string): GraphResult;
  impact(changedFiles: string[]): GraphResult & { testFiles: string[] };
  pathCandidates(badPath: string): GraphResult;
  symbolCandidates(term: string): GraphResult;
  /** Incremental re-index after the agent edits files. */
  noteEdit(files: string[]): Promise<void>;
}

const EMPTY_STATS: GraphStats = {
  files: 0,
  symbols: 0,
  edges: 0,
  unresolvedRefs: 0,
  heuristicEdges: 0,
  indexMs: 0,
  resolveMs: 0,
};

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
}

function filesOf(nodes: GraphNode[]): string[] {
  return [...new Set(nodes.map((n) => n.file))];
}

export class LocalGraphProvider implements GraphProvider {
  readonly enabled = true;
  private store?: GraphStore;
  private query?: GraphQuery;

  constructor(
    private readonly root: string,
    private readonly options: { perGroup?: number } = {},
  ) {}

  get stats(): GraphStats {
    return this.store?.stats ?? EMPTY_STATS;
  }

  async index(): Promise<void> {
    this.store = await indexRepo(this.root);
    this.query = new GraphQuery(this.store);
  }

  private q(): GraphQuery {
    if (!this.query) throw new Error('graph not indexed; call index() first');
    return this.query;
  }

  /**
   * Models routinely pass absolute paths, `./` prefixes and `path/to/file.go:42`. The graph
   * indexes repo-relative paths, so normalise before looking anything up - otherwise a
   * perfectly good anchor comes back as "not found" and the agent starts guessing again.
   */
  private normalize(anchor: string): string {
    let value = anchor.trim();
    const root = this.root.endsWith('/') ? this.root : `${this.root}/`;
    const absoluteRoot = path.resolve(this.root);
    if (value.startsWith(root)) value = value.slice(root.length);
    else if (value.startsWith(`${absoluteRoot}/`)) value = value.slice(absoluteRoot.length + 1);
    return value.replace(/^\.\//, '');
  }

  /**
   * Anchor-first expansion. An unknown anchor never produces a guess about which subsystem
   * the task belongs to - it produces the concrete alternatives that actually exist.
   */
  expand(rawAnchor: string, opts: { perGroup?: number } = {}): GraphResult {
    const anchor = this.normalize(rawAnchor);
    const { value, ms } = timed(() => {
      const resolution = this.q().resolveAnchor(anchor);
      if (resolution.status === 'notfound') {
        const candidates = this.q().pathCandidates(anchor);
        const symbols = this.q().symbolCandidates(anchor);
        const parts = [`No graph anchor named "${anchor}".`];
        if (candidates.length) parts.push(formatPathCandidates(anchor, candidates));
        if (symbols.length) parts.push(formatNodes('Similar symbols', symbols));
        return {
          text: parts.join('\n'),
          surfacedFiles: [...candidates.map((c) => c.file), ...filesOf(symbols)],
          count: candidates.length + symbols.length,
        };
      }
      if (resolution.status === 'ambiguous') {
        return {
          text: `"${anchor}" matches several symbols; expand one of them:\n${formatNodes('Candidates', resolution.candidates).split('\n').slice(1).join('\n')}`,
          surfacedFiles: filesOf(resolution.candidates),
          count: resolution.candidates.length,
        };
      }
      const neighborhood = this.q().neighbors(resolution.node!, {
        perGroup: opts.perGroup ?? this.options.perGroup,
      });
      return {
        text: formatNeighborhood(neighborhood),
        groups: neighborhood.groups,
        surfacedFiles: neighborhood.surfacedFiles,
        count: neighborhood.groups.reduce((sum, g) => sum + g.items.length, 0),
      };
    });
    return { ...value, ms };
  }

  find(rawName: string): GraphResult {
    const name = this.normalize(rawName);
    const { value, ms } = timed(() => {
      const nodes = this.q().findSymbol(name);
      return {
        text: nodes.length
          ? formatNodes(`Symbols matching "${name}"`, nodes)
          : `No symbol named "${name}" in the graph.`,
        surfacedFiles: filesOf(nodes),
        count: nodes.length,
      };
    });
    return { ...value, ms };
  }

  private relation(
    rawAnchor: string,
    label: string,
    pick: (node: GraphNode) => ReturnType<GraphQuery['callers']>,
  ): GraphResult {
    const anchor = this.normalize(rawAnchor);
    const { value, ms } = timed(() => {
      const resolution = this.q().resolveAnchor(anchor);
      if (!resolution.node) {
        return {
          text: `No graph anchor named "${anchor}".`,
          surfacedFiles: [],
          count: 0,
        };
      }
      const items = pick(resolution.node);
      const groups = items.length ? [{ label, items: items.slice(0, 20), truncated: Math.max(0, items.length - 20) }] : [];
      return {
        text: groups.length ? formatGroups(groups) : `${label}: none`,
        surfacedFiles: filesOf(items.map((i) => i.node)),
        count: items.length,
      };
    });
    return { ...value, ms };
  }

  callers(anchor: string): GraphResult {
    return this.relation(anchor, `Callers of ${anchor}`, (node) => this.q().relationOf(node, 'callers'));
  }

  callees(anchor: string): GraphResult {
    return this.relation(anchor, `Called by ${anchor}`, (node) => this.q().relationOf(node, 'callees'));
  }

  testsFor(anchor: string): GraphResult {
    return this.relation(anchor, `Tests covering ${anchor}`, (node) => this.q().relationOf(node, 'tests'));
  }

  impact(rawFiles: string[]): GraphResult & { testFiles: string[] } {
    const changedFiles = rawFiles.map((f) => this.normalize(f));
    const { value, ms } = timed(() => {
      const result = this.q().impact(changedFiles);
      const header = `Change surface for ${changedFiles.length} edited file(s): ${result.changed.length} symbol(s) touched`;
      const body = formatGroups(result.groups);
      return {
        text: body ? `${header}\n${body}` : `${header}\n  (nothing structurally depends on the change)`,
        groups: result.groups,
        surfacedFiles: [
          ...new Set(result.groups.flatMap((g) => g.items.map((i) => i.node.file))),
        ],
        count: result.groups.reduce((sum, g) => sum + g.items.length, 0),
        testFiles: result.testFiles,
      };
    });
    return { ...value, ms };
  }

  pathCandidates(rawPath: string): GraphResult {
    const badPath = this.normalize(rawPath);
    const { value, ms } = timed(() => {
      const candidates = this.q().pathCandidates(badPath);
      return {
        text: formatPathCandidates(badPath, candidates),
        surfacedFiles: candidates.map((c) => c.file),
        count: candidates.length,
      };
    });
    return { ...value, ms };
  }

  symbolCandidates(rawTerm: string): GraphResult {
    const term = this.normalize(rawTerm);
    const { value, ms } = timed(() => {
      const nodes = this.q().symbolCandidates(term);
      return {
        text: nodes.length ? formatNodes(`Symbols similar to "${term}"`, nodes) : '',
        surfacedFiles: filesOf(nodes),
        count: nodes.length,
      };
    });
    return { ...value, ms };
  }

  async noteEdit(files: string[]): Promise<void> {
    if (!this.store) return;
    await reindexFiles(this.store, files.map((f) => this.normalize(f)));
  }
}

/** The graph-off baseline: same agent, same tools, no structural answers. */
export class NullGraphProvider implements GraphProvider {
  readonly enabled = false;
  readonly stats = EMPTY_STATS;
  private empty(): GraphResult {
    return { text: '', surfacedFiles: [], count: 0, ms: 0 };
  }
  async index(): Promise<void> {}
  expand(): GraphResult {
    return this.empty();
  }
  find(): GraphResult {
    return this.empty();
  }
  callers(): GraphResult {
    return this.empty();
  }
  callees(): GraphResult {
    return this.empty();
  }
  testsFor(): GraphResult {
    return this.empty();
  }
  impact(): GraphResult & { testFiles: string[] } {
    return { ...this.empty(), testFiles: [] };
  }
  pathCandidates(): GraphResult {
    return this.empty();
  }
  symbolCandidates(): GraphResult {
    return this.empty();
  }
  async noteEdit(): Promise<void> {}
}
