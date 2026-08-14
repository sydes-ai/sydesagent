/**
 * Turning a trace into the numbers the project has to be judged on.
 *
 * The metric that decides whether the graph earned its place is `graphSuggestionsFollowed`
 * read together with `uniqueFilesInspected`, `modelCalls` and `totalTokens`: structure is
 * only worth having if it *replaces* exploration. Adding context while exploration stays flat
 * is the failure case, and these numbers are arranged to make that visible rather than hide it.
 */
import { costKnown } from '../llm/pricing.js';
import type { PathSource, TraceEvent } from './trace.js';

export interface RunMetrics {
  runId: string;
  task: string;
  repo: string;
  graph: boolean;
  provider: string;
  model: string;

  // Loop
  turns: number;
  stopReason: string;
  wallMs: number;

  // Model cost
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** All input tokens, cached or not, plus output. The size of the conversation actually sent. */
  totalTokens: number;
  /** Share of input tokens served from cache. */
  cacheHitRate: number;
  costUsd: number;
  costKnown: boolean;
  maxContextTokens: number;
  contextTrims: number;

  // Exploration
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  searchCalls: number;
  filesInspected: number;
  uniqueFilesInspected: number;
  repeatedReads: number;
  repeatedReadsStubbed: number;
  failedReads: number;
  failedReadsRecovered: number;

  // Graph
  graphLookups: number;
  graphLookupMsTotal: number;
  graphLookupMsMax: number;
  graphSuggestionsSurfaced: number;
  graphSuggestionsFollowed: number;
  graphFollowRate: number;
  enrichmentBytes: number;
  enrichmentSuppressed: number;

  // Outcome
  filesEdited: number;
  editedFiles: string[];
  edits: number;
  testRuns: number;
  testRunsPassed: number;
  /** Compiler / type-checker runs: a correctness oracle that costs no model tokens. */
  compileChecks: number;
  compileFailures: number;
  compileScoped: number;
  /** Identifiers an edit introduced that referred to nothing real. */
  unknownSymbolsFlagged: number;
  testFilesDiscovered: number;
  verified: boolean;

  /** Where the files the agent opened came from. */
  accessBySource: Record<PathSource | 'unseen', number>;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Anything with a run id and an event list: a live `Trace` or one loaded from disk. */
export interface TraceLike {
  runId: string;
  events: TraceEvent[];
}

function pick<T extends TraceEvent['type']>(
  events: TraceEvent[],
  type: T,
): Extract<TraceEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];
}

export function computeMetrics(trace: TraceLike, extra: { maxContextTokens?: number } = {}): RunMetrics {
  const events = trace.events;
  const start = pick(events, 'run_start')[0];
  const end = pick(events, 'run_end')[0];
  const modelCalls = pick(events, 'model_call');
  const toolCalls = pick(events, 'tool_call');
  const lookups = pick(events, 'graph_lookup');
  const accesses = pick(events, 'path_access');
  const enrichments = pick(events, 'enrichment');
  const testRuns = pick(events, 'test_run');
  const repeats = pick(events, 'repeat_read');
  const failures = pick(events, 'failed_read');
  const edits = pick(events, 'edit');
  const compiles = pick(events, 'compile_check');
  const unknowns = pick(events, 'unknown_symbol');
  const surfaced = pick(events, 'suggestion_surfaced');

  const toolCallsByName: Record<string, number> = {};
  for (const call of toolCalls) {
    toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
  }

  const cacheRead = modelCalls.reduce((sum, c) => sum + (c.cacheReadTokens ?? 0), 0);
  const totalInput = modelCalls.reduce(
    (sum, c) => sum + c.inputTokens + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0),
    0,
  );

  const reads = accesses.filter((a) => a.kind === 'read');
  const uniqueRead = new Set(reads.map((r) => r.pathName));

  const accessBySource: RunMetrics['accessBySource'] = {
    graph: 0,
    search: 0,
    model: 0,
    task: 0,
    unseen: 0,
  };
  // Attribute each *file*, not each access, so a file read five times counts once.
  const firstAccessPerPath = new Map<string, (typeof accesses)[number]>();
  for (const access of accesses) {
    if (!firstAccessPerPath.has(access.pathName)) firstAccessPerPath.set(access.pathName, access);
  }
  for (const access of firstAccessPerPath.values()) {
    accessBySource[access.attributedSource] += 1;
  }

  const graphSurfaced = new Set(
    surfaced.filter((s) => s.source === 'graph').flatMap((s) => s.paths),
  );
  const lookupTimes = lookups.map((l) => l.ms);
  const editedFiles = [...new Set(edits.map((e) => e.pathName))];
  const testFiles = new Set(
    lookups.flatMap((l) => l.surfaced).filter((f) => /(_test\.|\.test\.|\.spec\.)/.test(f)),
  );

  return {
    runId: trace.runId,
    task: start?.task ?? '',
    repo: start?.repo ?? '',
    graph: start?.graph ?? false,
    provider: start?.provider ?? '',
    model: start?.model ?? '',

    turns: end?.turn ?? modelCalls.length,
    stopReason: end?.reason ?? 'unknown',
    wallMs: end?.ms ?? 0,

    modelCalls: modelCalls.length,
    inputTokens: modelCalls.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: modelCalls.reduce((sum, c) => sum + c.outputTokens, 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: modelCalls.reduce((sum, c) => sum + (c.cacheWriteTokens ?? 0), 0),
    totalTokens:
      modelCalls.reduce(
        (sum, c) => sum + c.inputTokens + c.outputTokens + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0),
        0,
      ),
    cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    costUsd: Number(modelCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0).toFixed(6)),
    costKnown: costKnown(start?.model ?? ''),
    maxContextTokens: extra.maxContextTokens ?? Math.max(0, ...modelCalls.map((c) => c.contextTokens)),
    contextTrims: pick(events, 'context_trim').length,

    toolCalls: toolCalls.length,
    toolCallsByName,
    searchCalls: (toolCallsByName.grep ?? 0) + (toolCallsByName.glob ?? 0),
    filesInspected: reads.length,
    uniqueFilesInspected: uniqueRead.size,
    repeatedReads: repeats.length,
    repeatedReadsStubbed: repeats.filter((r) => r.unchanged).length,
    failedReads: failures.length,
    failedReadsRecovered: failures.filter((f) => f.recovered).length,

    graphLookups: lookups.length,
    graphLookupMsTotal: Number(lookupTimes.reduce((a, b) => a + b, 0).toFixed(2)),
    graphLookupMsMax: Number(percentile(lookupTimes, 100).toFixed(2)),
    graphSuggestionsSurfaced: graphSurfaced.size,
    graphSuggestionsFollowed: accessBySource.graph,
    graphFollowRate: graphSurfaced.size ? accessBySource.graph / graphSurfaced.size : 0,
    enrichmentBytes: enrichments.reduce((sum, e) => sum + e.bytes, 0),
    enrichmentSuppressed: enrichments.filter((e) => e.suppressed).length,

    filesEdited: editedFiles.length,
    editedFiles,
    edits: edits.length,
    testRuns: testRuns.length,
    testRunsPassed: testRuns.filter((t) => t.ok).length,
    compileChecks: compiles.length,
    compileFailures: compiles.filter((c) => !c.ok).length,
    compileScoped: compiles.filter((c) => c.scoped).length,
    unknownSymbolsFlagged: unknowns.length,
    testFilesDiscovered: testFiles.size,
    verified: testRuns.length > 0 && testRuns[testRuns.length - 1].ok,

    accessBySource,
  };
}

export interface AggregateMetrics {
  label: string;
  runs: number;
  resolved: number;
  resolveRate: number;
  totals: Record<string, number>;
  means: Record<string, number>;
}

const SUMMED_FIELDS = [
  'turns',
  'modelCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'costUsd',
  'toolCalls',
  'searchCalls',
  'filesInspected',
  'uniqueFilesInspected',
  'repeatedReads',
  'failedReads',
  'failedReadsRecovered',
  'graphLookups',
  'graphSuggestionsSurfaced',
  'graphSuggestionsFollowed',
  'enrichmentBytes',
  'filesEdited',
  'edits',
  'testRuns',
  'testRunsPassed',
  'compileChecks',
  'compileFailures',
  'compileScoped',
  'unknownSymbolsFlagged',
  'wallMs',
] as const;

export function aggregate(
  label: string,
  runs: RunMetrics[],
  resolvedFlags?: boolean[],
): AggregateMetrics {
  const totals: Record<string, number> = {};
  for (const field of SUMMED_FIELDS) {
    totals[field] = runs.reduce((sum, run) => sum + (run[field] as number), 0);
  }
  totals.maxContextTokens = Math.max(0, ...runs.map((r) => r.maxContextTokens));
  totals.graphLookupMsTotal = runs.reduce((sum, r) => sum + r.graphLookupMsTotal, 0);
  const inputAll = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  totals.cacheHitRate = inputAll > 0 ? totals.cacheReadTokens / inputAll : 0;

  const means: Record<string, number> = {};
  for (const [key, value] of Object.entries(totals)) {
    means[key] = runs.length ? value / runs.length : 0;
  }
  // A rate is already normalised; averaging it across runs again would understate it.
  means.cacheHitRate = totals.cacheHitRate;

  const resolved = resolvedFlags
    ? resolvedFlags.filter(Boolean).length
    : runs.filter((r) => r.verified).length;

  return {
    label,
    runs: runs.length,
    resolved,
    resolveRate: runs.length ? resolved / runs.length : 0,
    totals,
    means,
  };
}

export function metricsFromEvents(events: TraceEvent[], runId = 'loaded'): RunMetrics {
  return computeMetrics({ runId, events });
}
