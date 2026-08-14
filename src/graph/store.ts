import {
  fileNodeId,
  isSymbolKind,
  type FileFacts,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from './model.js';

export interface GraphStats {
  files: number;
  symbols: number;
  edges: number;
  unresolvedRefs: number;
  heuristicEdges: number;
  indexMs: number;
  resolveMs: number;
}

/**
 * In-memory graph with the indexes the query layer needs. Everything here is O(1)/O(k)
 * lookup: the whole point of the graph is that a structural question costs microseconds
 * instead of a model turn.
 */
export class GraphStore {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly outEdges = new Map<string, Set<string>>();
  readonly inEdges = new Map<string, Set<string>>();
  /**
   * Simple name -> node ids, case-sensitively. Case carries meaning: in Go it is the
   * difference between an exported and an unexported symbol, and folding `AddPokemon` into
   * `addPokemon` invents call and test edges between unrelated functions.
   */
  private readonly nameIndex = new Map<string, Set<string>>();
  /** Lowercased name -> node ids, used only for deliberate fuzzy lookups. */
  private readonly lowerNameIndex = new Map<string, Set<string>>();
  /** file -> symbol node ids */
  private readonly fileIndex = new Map<string, Set<string>>();
  /** Per-file extraction output, retained so edges can be rebuilt after an edit. */
  readonly facts = new Map<string, FileFacts>();

  /** Go module path from go.mod, used to map import paths to directories. */
  goModule?: string;
  /** tsconfig `paths` aliases, prefix -> target prefixes (repo-relative). */
  tsPaths = new Map<string, string[]>();

  stats: GraphStats = {
    files: 0,
    symbols: 0,
    edges: 0,
    unresolvedRefs: 0,
    heuristicEdges: 0,
    indexMs: 0,
    resolveMs: 0,
  };

  constructor(readonly root: string) {}

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    let bucket = this.nameIndex.get(node.name);
    if (!bucket) this.nameIndex.set(node.name, (bucket = new Set()));
    bucket.add(node.id);
    const lower = node.name.toLowerCase();
    let lowerBucket = this.lowerNameIndex.get(lower);
    if (!lowerBucket) this.lowerNameIndex.set(lower, (lowerBucket = new Set()));
    lowerBucket.add(node.id);
    if (isSymbolKind(node.kind)) {
      let files = this.fileIndex.get(node.file);
      if (!files) this.fileIndex.set(node.file, (files = new Set()));
      files.add(node.id);
    }
  }

  addEdge(edge: GraphEdge): void {
    if (edge.from === edge.to) return;
    if (this.edges.has(edge.id)) return;
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    this.edges.set(edge.id, edge);
    let out = this.outEdges.get(edge.from);
    if (!out) this.outEdges.set(edge.from, (out = new Set()));
    out.add(edge.id);
    let inc = this.inEdges.get(edge.to);
    if (!inc) this.inEdges.set(edge.to, (inc = new Set()));
    inc.add(edge.id);
  }

  /** Drops every edge; used before a full re-resolution pass. */
  clearEdges(): void {
    this.edges.clear();
    this.outEdges.clear();
    this.inEdges.clear();
  }

  /** Removes a file, its symbols and its facts. Edges are rebuilt by the resolver. */
  removeFile(relPath: string): void {
    const symbolIds = this.fileIndex.get(relPath) ?? new Set<string>();
    for (const id of [...symbolIds, fileNodeId(relPath)]) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this.nameIndex.get(node.name)?.delete(id);
      this.lowerNameIndex.get(node.name.toLowerCase())?.delete(id);
      this.nodes.delete(id);
    }
    this.fileIndex.delete(relPath);
    this.facts.delete(relPath);
  }

  fileNode(relPath: string): GraphNode | undefined {
    return this.nodes.get(fileNodeId(relPath));
  }

  symbolsInFile(relPath: string): GraphNode[] {
    const ids = this.fileIndex.get(relPath);
    if (!ids) return [];
    return [...ids].map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  /** Exact name lookup. Pass `fuzzyCase` only when a near-miss is acceptable. */
  findByName(name: string, kinds?: NodeKind[], fuzzyCase = false): GraphNode[] {
    const ids = fuzzyCase
      ? this.lowerNameIndex.get(name.toLowerCase())
      : this.nameIndex.get(name);
    if (!ids) return [];
    const nodes = [...ids].map((id) => this.nodes.get(id)!).filter(Boolean);
    return kinds ? nodes.filter((n) => kinds.includes(n.kind)) : nodes;
  }

  /** The symbol whose line range encloses `line`, innermost first. */
  symbolAt(relPath: string, line: number): GraphNode | undefined {
    let best: GraphNode | undefined;
    for (const node of this.symbolsInFile(relPath)) {
      if (line < node.startLine || line > node.endLine) continue;
      if (!best || node.endLine - node.startLine < best.endLine - best.startLine) best = node;
    }
    return best;
  }

  files(): string[] {
    return [...this.facts.keys()];
  }

  outgoing(nodeId: string): GraphEdge[] {
    const ids = this.outEdges.get(nodeId);
    if (!ids) return [];
    return [...ids].map((id) => this.edges.get(id)!).filter(Boolean);
  }

  incoming(nodeId: string): GraphEdge[] {
    const ids = this.inEdges.get(nodeId);
    if (!ids) return [];
    return [...ids].map((id) => this.edges.get(id)!).filter(Boolean);
  }

  recomputeStats(): void {
    let symbols = 0;
    for (const node of this.nodes.values()) if (isSymbolKind(node.kind)) symbols++;
    let heuristic = 0;
    for (const edge of this.edges.values()) if (edge.confidence === 'heuristic') heuristic++;
    this.stats.files = this.facts.size;
    this.stats.symbols = symbols;
    this.stats.edges = this.edges.size;
    this.stats.heuristicEdges = heuristic;
  }

  toJSON(): unknown {
    return {
      version: 1,
      root: this.root,
      goModule: this.goModule,
      tsPaths: [...this.tsPaths.entries()],
      nodes: [...this.nodes.values()],
      facts: [...this.facts.values()],
      stats: this.stats,
    };
  }

  static fromJSON(data: any): GraphStore {
    const store = new GraphStore(data.root);
    store.goModule = data.goModule;
    store.tsPaths = new Map(data.tsPaths ?? []);
    for (const node of data.nodes as GraphNode[]) store.addNode(node);
    for (const facts of data.facts as FileFacts[]) store.facts.set(facts.file, facts);
    store.stats = data.stats;
    return store;
  }
}
