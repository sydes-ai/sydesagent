/**
 * What the run has already established.
 *
 * The point is not to save filesystem calls - those are free. It is to stop paying model
 * attention for the same evidence twice, and to make "did the graph actually help?" an
 * answerable question rather than an assertion.
 */
import type { PathSource } from '../telemetry/trace.js';

export interface ReadRecord {
  path: string;
  hash: string;
  firstTurn: number;
  lastTurn: number;
  timesRead: number;
  lines: number;
}

export interface EditRecord {
  path: string;
  turn: number;
  kind: 'write' | 'edit';
  addedLines: number;
  removedLines: number;
}

export interface SurfaceRecord {
  path: string;
  turn: number;
  source: PathSource;
}

export interface AccessAttribution {
  attributedSource: PathSource | 'unseen';
  firstSurfacedTurn?: number;
}

export class Ledger {
  readonly reads = new Map<string, ReadRecord>();
  readonly failedPaths = new Map<string, number>();
  readonly searches = new Map<string, number>();
  readonly expansions = new Set<string>();
  /** Structural facts already rendered to the model, keyed `label:nodeId`. */
  readonly shownFacts = new Set<string>();
  readonly edits = new Map<string, EditRecord>();
  readonly testRuns: { command: string; ok: boolean; turn: number }[] = [];
  /** First time each path was put in front of the model, and by what. */
  private readonly surfaced = new Map<string, SurfaceRecord>();

  /**
   * Records that a path was shown to the model. First writer wins: if grep already listed a
   * file, a later graph expansion does not get to claim credit for the agent finding it.
   */
  noteSurfaced(paths: string[], source: PathSource, turn: number): string[] {
    const fresh: string[] = [];
    for (const path of paths) {
      if (this.surfaced.has(path)) continue;
      this.surfaced.set(path, { path, turn, source });
      fresh.push(path);
    }
    return fresh;
  }

  /** Who gets credit for the agent opening this path. */
  attribute(path: string): AccessAttribution {
    const record = this.surfaced.get(path);
    if (!record) return { attributedSource: 'unseen' };
    return { attributedSource: record.source, firstSurfacedTurn: record.turn };
  }

  surfacedBy(source: PathSource): string[] {
    return [...this.surfaced.values()].filter((r) => r.source === source).map((r) => r.path);
  }

  noteRead(path: string, hash: string, lines: number, turn: number): ReadRecord {
    const existing = this.reads.get(path);
    if (existing) {
      existing.timesRead++;
      existing.lastTurn = turn;
      const changed = existing.hash !== hash;
      existing.hash = hash;
      existing.lines = lines;
      if (changed) existing.firstTurn = turn;
      return existing;
    }
    const record: ReadRecord = { path, hash, firstTurn: turn, lastTurn: turn, timesRead: 1, lines };
    this.reads.set(path, record);
    return record;
  }

  /** True when the model already has this exact content in its context. */
  hasFreshRead(path: string, hash: string): boolean {
    const record = this.reads.get(path);
    return !!record && record.hash === hash;
  }

  noteFailedRead(path: string, turn: number): void {
    this.failedPaths.set(path, turn);
  }

  noteSearch(pattern: string): number {
    const count = (this.searches.get(pattern) ?? 0) + 1;
    this.searches.set(pattern, count);
    return count;
  }

  noteEdit(record: EditRecord): void {
    this.edits.set(record.path, record);
    // An edited file's content in context is now stale; force the next read to be real.
    this.reads.delete(record.path);
  }

  editedFiles(): string[] {
    return [...this.edits.keys()];
  }

  /** Filters structural facts down to the ones the model has not been shown yet. */
  unseenFacts<T>(label: string, items: T[], idOf: (item: T) => string): { fresh: T[]; suppressed: number } {
    const fresh: T[] = [];
    let suppressed = 0;
    for (const item of items) {
      const key = `${label}:${idOf(item)}`;
      if (this.shownFacts.has(key)) {
        suppressed++;
        continue;
      }
      fresh.push(item);
    }
    return { fresh, suppressed };
  }

  markFactsShown<T>(label: string, items: T[], idOf: (item: T) => string): void {
    for (const item of items) this.shownFacts.add(`${label}:${idOf(item)}`);
  }
}
