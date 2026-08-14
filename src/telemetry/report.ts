/**
 * The A/B report.
 *
 * It is written to be able to say "the graph did not help". Exploration metrics are marked
 * `lower-is-better` and cost metrics likewise; the verdict is computed from those, not chosen
 * by hand, so a null or negative result shows up as plainly as a positive one.
 */
import { padRight } from '../util/text.js';
import type { AggregateMetrics } from './metrics.js';

interface Row {
  label: string;
  key: string;
  direction: 'lower' | 'higher';
  /** Counts toward the headline verdict. */
  headline?: boolean;
  format?: (value: number) => string;
}

const ROWS: Row[] = [
  { label: 'Resolved / verified', key: '__resolveRate', direction: 'higher', headline: true, format: (v) => `${(v * 100).toFixed(0)}%` },
  { label: 'Model calls', key: 'modelCalls', direction: 'lower', headline: true },
  { label: 'Total tokens', key: 'totalTokens', direction: 'lower', headline: true },
  { label: 'Tool calls', key: 'toolCalls', direction: 'lower', headline: true },
  { label: 'Unique files inspected', key: 'uniqueFilesInspected', direction: 'lower', headline: true },
  { label: 'Search calls (grep/glob)', key: 'searchCalls', direction: 'lower' },
  { label: 'Files inspected (total reads)', key: 'filesInspected', direction: 'lower' },
  { label: 'Repeated reads', key: 'repeatedReads', direction: 'lower' },
  { label: 'Failed reads', key: 'failedReads', direction: 'lower' },
  { label: 'Failed reads recovered', key: 'failedReadsRecovered', direction: 'higher' },
  { label: 'Max context tokens', key: 'maxContextTokens', direction: 'lower' },
  { label: 'Turns', key: 'turns', direction: 'lower' },
  { label: 'Files edited', key: 'filesEdited', direction: 'higher' },
  { label: 'Test runs passed', key: 'testRunsPassed', direction: 'higher' },
  { label: 'Graph lookups', key: 'graphLookups', direction: 'higher' },
  { label: 'Graph lookup ms (total)', key: 'graphLookupMsTotal', direction: 'lower' },
  { label: 'Graph suggestions surfaced', key: 'graphSuggestionsSurfaced', direction: 'higher' },
  { label: 'Graph suggestions followed', key: 'graphSuggestionsFollowed', direction: 'higher' },
  { label: 'Enrichment bytes added', key: 'enrichmentBytes', direction: 'lower' },
];

function valueOf(metrics: AggregateMetrics, key: string): number {
  if (key === '__resolveRate') return metrics.resolveRate;
  return metrics.means[key] ?? 0;
}

function formatValue(row: Row, value: number): string {
  if (row.format) return row.format(value);
  return value >= 1000 ? value.toFixed(0) : value.toFixed(2).replace(/\.00$/, '');
}

function deltaText(row: Row, baseline: number, candidate: number): string {
  if (baseline === 0 && candidate === 0) return '=';
  const absolute = candidate - baseline;
  const relative = baseline === 0 ? Number.POSITIVE_INFINITY : (absolute / baseline) * 100;
  const sign = absolute > 0 ? '+' : '';
  const pct = Number.isFinite(relative) ? ` (${sign}${relative.toFixed(0)}%)` : '';
  return `${sign}${formatValue(row, absolute)}${pct}`;
}

export interface Verdict {
  helped: boolean;
  reason: string;
  explorationDelta: number;
  correctnessDelta: number;
}

/**
 * The graph earns its place only if exploration goes down without correctness going down.
 * Adding structural context while exploration stays flat is explicitly a failure.
 */
export function verdict(baseline: AggregateMetrics, candidate: AggregateMetrics): Verdict {
  const explorationKeys = ['modelCalls', 'toolCalls', 'uniqueFilesInspected', 'totalTokens'];
  const ratios = explorationKeys.map((key) => {
    const base = valueOf(baseline, key);
    const cand = valueOf(candidate, key);
    return base === 0 ? 1 : cand / base;
  });
  const explorationDelta = ratios.reduce((a, b) => a + b, 0) / ratios.length - 1;
  const correctnessDelta = candidate.resolveRate - baseline.resolveRate;

  if (correctnessDelta < -0.001) {
    return {
      helped: false,
      reason: `correctness dropped by ${(correctnessDelta * -100).toFixed(0)} points; exploration savings do not compensate`,
      explorationDelta,
      correctnessDelta,
    };
  }
  if (explorationDelta < -0.05) {
    return {
      helped: true,
      reason: `exploration fell ${(explorationDelta * -100).toFixed(0)}% at equal or better correctness`,
      explorationDelta,
      correctnessDelta,
    };
  }
  return {
    helped: false,
    reason:
      explorationDelta > 0.05
        ? `exploration rose ${(explorationDelta * 100).toFixed(0)}%: the graph added work instead of replacing it`
        : 'no material change in exploration; the graph did not pay for itself',
    explorationDelta,
    correctnessDelta,
  };
}

export function renderReport(baseline: AggregateMetrics, candidate: AggregateMetrics): string {
  const width = Math.max(...ROWS.map((r) => r.label.length));
  const lines: string[] = [];

  lines.push(`# Sydes A/B report`);
  lines.push('');
  lines.push(`Baseline: **${baseline.label}** (${baseline.runs} run(s))`);
  lines.push(`Candidate: **${candidate.label}** (${candidate.runs} run(s))`);
  lines.push('');
  lines.push('Per-run means unless noted. Arrows mark the direction that counts as better.');
  lines.push('');
  lines.push(`| ${padRight('Metric', width)} | ${baseline.label} | ${candidate.label} | Delta | Better |`);
  lines.push(`| ${'-'.repeat(width)} | --- | --- | --- | --- |`);

  for (const row of ROWS) {
    const base = valueOf(baseline, row.key);
    const cand = valueOf(candidate, row.key);
    if (base === 0 && cand === 0) continue;
    lines.push(
      `| ${padRight(row.label, width)} | ${formatValue(row, base)} | ${formatValue(row, cand)} | ${deltaText(row, base, cand)} | ${row.direction === 'lower' ? '↓' : '↑'} |`,
    );
  }

  const result = verdict(baseline, candidate);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(`**${result.helped ? 'The graph replaced work' : 'The graph did not replace work'}** — ${result.reason}.`);
  lines.push('');
  lines.push(
    `Exploration index change: ${(result.explorationDelta * 100).toFixed(1)}% (mean of model calls, tool calls, unique files inspected, total tokens). ` +
      `Correctness change: ${(result.correctnessDelta * 100).toFixed(1)} points.`,
  );

  return lines.join('\n');
}
