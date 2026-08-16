import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every event the experiment needs. The central claim - that structure replaces exploration
 * rather than adding to it - is only testable if each run leaves an auditable record, so the
 * trace is written for both the graph-on and graph-off arms in the same shape.
 */
export type TraceEvent =
  | { type: 'run_start'; runId: string; task: string; repo: string; graph: boolean; testBaseline: number | null; provider: string; model: string; ts: number }
  | { type: 'model_call'; turn: number; latencyMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; toolCalls: string[]; stopReason: string; contextTokens: number }
  | { type: 'context_trim'; turn: number; beforeTokens: number; afterTokens: number; trimmedResults: number }
  | { type: 'tool_call'; turn: number; name: string; args: Record<string, unknown>; latencyMs: number; ok: boolean; resultBytes: number; note?: string }
  | { type: 'graph_lookup'; turn: number; kind: string; anchor: string; ms: number; results: number; surfaced: string[] }
  | { type: 'suggestion_surfaced'; turn: number; paths: string[]; source: PathSource }
  | { type: 'path_access'; turn: number; pathName: string; kind: 'read' | 'edit'; attributedSource: PathSource | 'unseen'; firstSurfacedTurn?: number }
  | { type: 'repeat_read'; turn: number; pathName: string; firstTurn: number; unchanged: boolean }
  | { type: 'failed_read'; turn: number; pathName: string; recovered: boolean; candidates: string[] }
  | { type: 'edit'; turn: number; pathName: string; kind: 'write' | 'edit'; addedLines: number; removedLines: number }
  | { type: 'test_run'; turn: number; command: string; ok: boolean; ms: number; preexisting?: number }
  | { type: 'enrichment'; turn: number; kind: 'read_footer' | 'failed_read' | 'empty_search' | 'post_edit' | 'symbol_check'; bytes: number; suppressed: boolean }
  | { type: 'unknown_symbol'; turn: number; pathName: string; name: string; reason: string; candidates: string[] }
  | { type: 'compile_check'; turn: number; command: string; scoped: boolean; ok: boolean; ms: number }
  | { type: 'run_end'; turn: number; reason: string; ms: number; editedFiles: string[] };

export type PathSource = 'graph' | 'search' | 'model' | 'task';

export class Trace {
  readonly events: TraceEvent[] = [];

  constructor(readonly runId: string) {}

  emit(event: TraceEvent): void {
    this.events.push(event);
  }

  ofType<T extends TraceEvent['type']>(type: T): Extract<TraceEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];
  }

  async write(file: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}
