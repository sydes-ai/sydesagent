import { describe, expect, it } from 'vitest';
import { costKnown, estimateCost, priceFor } from '../src/llm/pricing.js';
import { aggregate, computeMetrics, type RunMetrics } from '../src/telemetry/metrics.js';
import { renderReport, verdict } from '../src/telemetry/report.js';
import { Trace, type TraceEvent } from '../src/telemetry/trace.js';

function trace(events: TraceEvent[]): Trace {
  const t = new Trace('test');
  for (const event of events) t.emit(event);
  return t;
}

const start: TraceEvent = {
  type: 'run_start',
  runId: 'test',
  task: 'fix it',
  repo: '/repo',
  graph: true,
  provider: 'mock',
  model: 'mock-model',
  ts: 0,
};

describe('metrics', () => {
  it('derives loop, exploration and outcome counts from a trace', () => {
    const metrics = computeMetrics(
      trace([
        start,
        { type: 'model_call', turn: 1, latencyMs: 10, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, toolCalls: ['grep'], stopReason: 'tool_calls', contextTokens: 500 },
        { type: 'tool_call', turn: 1, name: 'grep', args: {}, latencyMs: 5, ok: true, resultBytes: 100 },
        { type: 'model_call', turn: 2, latencyMs: 10, inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, toolCalls: ['read_file'], stopReason: 'tool_calls', contextTokens: 900 },
        { type: 'tool_call', turn: 2, name: 'read_file', args: {}, latencyMs: 5, ok: true, resultBytes: 900 },
        { type: 'path_access', turn: 2, pathName: 'a.go', kind: 'read', attributedSource: 'search', firstSurfacedTurn: 1 },
        { type: 'path_access', turn: 3, pathName: 'a.go', kind: 'read', attributedSource: 'search', firstSurfacedTurn: 1 },
        { type: 'repeat_read', turn: 3, pathName: 'a.go', firstTurn: 2, unchanged: true },
        { type: 'edit', turn: 4, pathName: 'a.go', kind: 'edit', addedLines: 1, removedLines: 1 },
        { type: 'test_run', turn: 5, command: 'go test ./...', ok: true, ms: 900 },
        { type: 'run_end', turn: 5, reason: 'finished', ms: 5000, editedFiles: ['a.go'] },
      ]),
    );

    expect(metrics.modelCalls).toBe(2);
    expect(metrics.totalTokens).toBe(460);
    expect(metrics.costUsd).toBeCloseTo(0.003, 6);
    expect(metrics.maxContextTokens).toBe(900);
    expect(metrics.filesInspected).toBe(2);
    expect(metrics.uniqueFilesInspected).toBe(1);
    expect(metrics.repeatedReads).toBe(1);
    expect(metrics.searchCalls).toBe(1);
    expect(metrics.filesEdited).toBe(1);
    expect(metrics.verified).toBe(true);
  });

  /**
   * Attribution is the metric most able to flatter the graph, so it is pinned down: a file
   * grep listed first belongs to grep, no matter how often the graph mentions it later.
   */
  it('credits the graph only for paths nothing else surfaced first', () => {
    const metrics = computeMetrics(
      trace([
        start,
        { type: 'suggestion_surfaced', turn: 1, paths: ['known.go'], source: 'search' },
        { type: 'suggestion_surfaced', turn: 2, paths: ['found.go', 'unopened.go'], source: 'graph' },
        { type: 'path_access', turn: 3, pathName: 'known.go', kind: 'read', attributedSource: 'search', firstSurfacedTurn: 1 },
        { type: 'path_access', turn: 4, pathName: 'found.go', kind: 'read', attributedSource: 'graph', firstSurfacedTurn: 2 },
        { type: 'path_access', turn: 5, pathName: 'guessed.go', kind: 'read', attributedSource: 'unseen' },
        { type: 'run_end', turn: 5, reason: 'finished', ms: 10, editedFiles: [] },
      ]),
    );

    expect(metrics.graphSuggestionsSurfaced).toBe(2);
    expect(metrics.graphSuggestionsFollowed).toBe(1);
    expect(metrics.graphFollowRate).toBe(0.5);
    expect(metrics.accessBySource).toMatchObject({ graph: 1, search: 1, unseen: 1 });
  });
});

function fakeRun(overrides: Partial<RunMetrics>): RunMetrics {
  return {
    runId: 'r',
    task: '',
    repo: '',
    graph: true,
    provider: 'mock',
    model: 'm',
    turns: 10,
    stopReason: 'finished',
    wallMs: 1000,
    modelCalls: 10,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1100,
    cacheHitRate: 0,
    costUsd: 0.01,
    costKnown: true,
    maxContextTokens: 5000,
    contextTrims: 0,
    toolCalls: 20,
    toolCallsByName: {},
    searchCalls: 6,
    filesInspected: 12,
    uniqueFilesInspected: 8,
    repeatedReads: 4,
    repeatedReadsStubbed: 4,
    failedReads: 2,
    failedReadsRecovered: 0,
    graphLookups: 0,
    graphLookupMsTotal: 0,
    graphLookupMsMax: 0,
    graphSuggestionsSurfaced: 0,
    graphSuggestionsFollowed: 0,
    graphFollowRate: 0,
    enrichmentBytes: 0,
    enrichmentSuppressed: 0,
    filesEdited: 1,
    editedFiles: ['a.go'],
    edits: 1,
    testRuns: 1,
    testRunsPassed: 1,
    testFilesDiscovered: 1,
    verified: true,
    accessBySource: { graph: 0, search: 8, model: 0, task: 0, unseen: 0 },
    ...overrides,
  };
}

describe('cost and caching', () => {
  /** Cached prefix bills at a fraction of the input rate; conflating them hides the saving. */
  it('prices cached input far below fresh input', () => {
    const fresh = estimateCost('claude-sonnet-5', { inputTokens: 100_000, outputTokens: 0 });
    const cached = estimateCost('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 100_000,
    });

    expect(fresh).toBeCloseTo(0.3, 6);
    expect(cached).toBeCloseTo(0.03, 6);
    expect(cached).toBeLessThan(fresh);
  });

  it('resolves dated model ids by longest prefix', () => {
    expect(priceFor('gpt-5-mini-2026-08-07')).toEqual(priceFor('gpt-5-mini'));
    // The longer key must win: gpt-5-mini is not gpt-5.
    expect(priceFor('gpt-5-mini')).not.toEqual(priceFor('gpt-5'));
  });

  it('returns zero rather than guessing for an unpriced model', () => {
    expect(costKnown('some-unreleased-model')).toBe(false);
    expect(estimateCost('some-unreleased-model', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });

  it('derives cache hit rate over all input tokens', () => {
    const metrics = computeMetrics(
      trace([
        start,
        { type: 'model_call', turn: 1, latencyMs: 5, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, toolCalls: [], stopReason: 'stop', contextTokens: 1000 },
        { type: 'model_call', turn: 2, latencyMs: 5, inputTokens: 200, outputTokens: 50, cacheReadTokens: 1800, cacheWriteTokens: 0, costUsd: 0.004, toolCalls: [], stopReason: 'stop', contextTokens: 2000 },
        { type: 'run_end', turn: 2, reason: 'finished', ms: 10, editedFiles: [] },
      ]),
    );

    expect(metrics.cacheReadTokens).toBe(1800);
    expect(metrics.cacheHitRate).toBeCloseTo(1800 / 3000, 6);
    expect(metrics.costUsd).toBeCloseTo(0.014, 6);
    // totalTokens counts everything actually sent, cached or not.
    expect(metrics.totalTokens).toBe(3100);
  });
});

describe('A/B verdict', () => {
  const baseline = aggregate('base', [fakeRun({ graph: false })]);

  it('says the graph helped when exploration falls at equal correctness', () => {
    const candidate = aggregate('graph', [
      fakeRun({ modelCalls: 6, toolCalls: 11, uniqueFilesInspected: 4, totalTokens: 700 }),
    ]);
    const result = verdict(baseline, candidate);
    expect(result.helped).toBe(true);
    expect(result.explorationDelta).toBeLessThan(-0.2);
    expect(renderReport(baseline, candidate)).toContain('The graph replaced work');
  });

  /** The failure the project must be able to report about itself. */
  it('says the graph failed when it adds context without removing work', () => {
    const candidate = aggregate('graph', [
      fakeRun({ modelCalls: 10, toolCalls: 22, uniqueFilesInspected: 9, totalTokens: 1600, enrichmentBytes: 5000 }),
    ]);
    const result = verdict(baseline, candidate);
    expect(result.helped).toBe(false);
    expect(result.reason).toContain('added work instead of replacing it');
    expect(renderReport(baseline, candidate)).toContain('The graph did not replace work');
  });

  it('refuses to call it a win when correctness drops', () => {
    const candidate = aggregate('graph', [
      fakeRun({ modelCalls: 2, toolCalls: 4, uniqueFilesInspected: 2, totalTokens: 200, verified: false }),
    ]);
    const result = verdict(baseline, candidate);
    expect(result.helped).toBe(false);
    expect(result.reason).toContain('correctness dropped');
  });

  it('reports no-change honestly', () => {
    const candidate = aggregate('graph', [fakeRun({})]);
    expect(verdict(baseline, candidate).reason).toContain('did not pay for itself');
  });
});
