#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { runAgent } from '../agent/loop.js';
import { runVerification } from '../agent/verify.js';
import { loadAgentConfig, type AgentConfig } from '../config.js';
import { LocalExec } from '../exec/local.js';
import { LocalGraphProvider, NullGraphProvider, type GraphProvider } from '../graph/provider.js';
import { createProvider, DEFAULT_MODELS, type ProviderName } from '../llm/registry.js';
import { aggregate, computeMetrics, metricsFromEvents, type RunMetrics } from '../telemetry/metrics.js';
import { renderReport } from '../telemetry/report.js';
import type { TraceEvent } from '../telemetry/trace.js';
import { loadDataset } from '../bench/dataset.js';
import { evaluateInstance, renderEvalSummary, summarise, type InstanceEval } from '../bench/graph-eval.js';
import { type BenchOptions } from '../bench/runner.js';
import { runSweep } from '../bench/sweep.js';
import { runOfficialHarness } from '../bench/harness.js';

const program = new Command();
program.name('sydes').description('Sydes: a graph-aware coding agent').version('0.1.0');

function agentConfigFrom(opts: Record<string, any>): AgentConfig {
  const graph = opts.graph !== 'off' && opts.graph !== false;
  return loadAgentConfig({
    graph,
    maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
    maxTotalTokens: opts.maxTokens ? Number(opts.maxTokens) : undefined,
    allowBash: opts.bash !== false,
    enrichment: opts.enrichment === false ? { readFooter: false, failedReadRecovery: false, emptySearchHints: false, postEditImpact: false } : undefined,
  } as Partial<AgentConfig>);
}

async function makeGraph(root: string, enabled: boolean): Promise<GraphProvider> {
  const graph = enabled ? new LocalGraphProvider(root) : new NullGraphProvider();
  await graph.index();
  return graph;
}

program
  .command('index')
  .description('Index a repository and print graph statistics')
  .argument('<repo>', 'repository root')
  .action(async (repo: string) => {
    const graph = new LocalGraphProvider(path.resolve(repo));
    await graph.index();
    const stats = graph.stats;
    console.log(`indexed ${path.resolve(repo)}`);
    console.log(`  files          ${stats.files}`);
    console.log(`  symbols        ${stats.symbols}`);
    console.log(`  relationships  ${stats.edges}`);
    console.log(`  heuristic      ${stats.heuristicEdges} (${((stats.heuristicEdges / Math.max(1, stats.edges)) * 100).toFixed(1)}% of edges)`);
    console.log(`  unresolved     ${stats.unresolvedRefs} references`);
    console.log(`  index / resolve ${stats.indexMs}ms / ${stats.resolveMs}ms`);
  });

const graphCommand = program.command('graph').description('Query the code graph directly');

for (const [name, description] of [
  ['expand', 'structural neighborhood of a file or symbol'],
  ['callers', 'what calls a symbol'],
  ['callees', 'what a symbol calls'],
  ['tests', 'tests covering a file or symbol'],
  ['find', 'locate a symbol by name'],
] as const) {
  graphCommand
    .command(name)
    .description(description)
    .argument('<anchor>', 'file path or symbol name')
    .option('-r, --repo <path>', 'repository root', '.')
    .action(async (anchor: string, opts: { repo: string }) => {
      const graph = new LocalGraphProvider(path.resolve(opts.repo));
      await graph.index();
      const result =
        name === 'expand'
          ? graph.expand(anchor)
          : name === 'callers'
            ? graph.callers(anchor)
            : name === 'callees'
              ? graph.callees(anchor)
              : name === 'tests'
                ? graph.testsFor(anchor)
                : graph.find(anchor);
      console.log(result.text || '(nothing)');
      console.error(`[${result.count} result(s) in ${result.ms}ms]`);
    });
}

graphCommand
  .command('impact')
  .description('change surface of the given files')
  .argument('<files...>', 'repository-relative files')
  .option('-r, --repo <path>', 'repository root', '.')
  .action(async (files: string[], opts: { repo: string }) => {
    const graph = new LocalGraphProvider(path.resolve(opts.repo));
    await graph.index();
    const result = graph.impact(files);
    console.log(result.text);
    console.error(`[${result.count} result(s) in ${result.ms}ms]`);
  });

program
  .command('run')
  .description('Run the agent on a task in a repository')
  .requiredOption('-r, --repo <path>', 'repository root')
  .requiredOption('-t, --task <text>', 'task description, or @file to read from disk')
  .option('-p, --provider <name>', 'openai | anthropic | ollama | replay', 'ollama')
  .option('-m, --model <name>', 'model id')
  .option('-g, --graph <mode>', 'on | off', 'on')
  .option('--max-turns <n>', 'turn budget')
  .option('--max-tokens <n>', 'total token budget')
  .option('--no-bash', 'disable the bash tool')
  .option('--no-enrichment', 'disable automatic graph enrichment (ablation)')
  .option('--cassette <file>', 'record or replay a transcript')
  .option('--record', 'record to the cassette instead of replaying')
  .option('-o, --out <dir>', 'directory for the trace and metrics', 'runs')
  .option('-q, --quiet', 'suppress per-tool progress output')
  .action(async (opts) => {
    const root = path.resolve(opts.repo);
    const task = opts.task.startsWith('@')
      ? await readFile(opts.task.slice(1), 'utf8')
      : opts.task;

    const useGraph = opts.graph !== 'off';
    const config = agentConfigFrom(opts);
    const provider = (opts.provider as ProviderName) ?? 'ollama';

    const graph = await makeGraph(root, useGraph);
    if (useGraph) {
      console.error(
        `[graph] ${graph.stats.files} files, ${graph.stats.symbols} symbols, ${graph.stats.edges} relationships (${graph.stats.indexMs}ms)`,
      );
    }

    const llm = createProvider({
      provider,
      model: opts.model ?? DEFAULT_MODELS[provider],
      cassette: opts.cassette,
      cassetteMode: opts.record ? 'record' : 'replay',
    });

    const exec = new LocalExec(root);
    const result = await runAgent({
      root,
      task,
      llm,
      graph,
      exec,
      config,
      onEvent: opts.quiet ? undefined : (line) => console.error(`[agent] ${line}`),
    });

    if (result.editedFiles.length && !result.ledger.testRuns.length) {
      const verification = await runVerification(root, result.editedFiles, graph, exec, config.bashTimeoutMs);
      if (verification) {
        console.error(`[verify] ${verification.plan.command} → ${verification.ok ? 'PASS' : 'FAIL'}`);
        result.trace.emit({
          type: 'test_run',
          turn: result.turns,
          command: verification.plan.command,
          ok: verification.ok,
          ms: verification.ms,
        });
      }
    }

    const runDir = path.join(path.resolve(opts.out), `${result.runId}-${useGraph ? 'graph' : 'base'}`);
    await mkdir(runDir, { recursive: true });
    await result.trace.write(path.join(runDir, 'trace.jsonl'));
    const metrics = computeMetrics(result.trace, { maxContextTokens: result.maxContextTokens });
    await writeFile(path.join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

    console.log(`\n${result.finalMessage}\n`);
    console.error(
      `[done] ${result.stopReason} after ${result.turns} turn(s); ` +
        `${metrics.modelCalls} model calls, ${metrics.toolCalls} tool calls, ` +
        `${metrics.uniqueFilesInspected} unique files, ${metrics.totalTokens} tokens`,
    );
    if (useGraph) {
      console.error(
        `[graph] ${metrics.graphLookups} lookups in ${metrics.graphLookupMsTotal}ms; ` +
          `${metrics.graphSuggestionsFollowed}/${metrics.graphSuggestionsSurfaced} suggestions followed`,
      );
    }
    console.error(`[out] ${runDir}`);
  });

program
  .command('bench')
  .description('Run Multi-SWE-bench instances and emit a predictions file')
  .requiredOption('-d, --dataset <files...>', 'dataset JSONL file(s)')
  .option('-g, --graph <mode>', 'on | off', 'on')
  .option('-p, --provider <name>', 'openai | anthropic | ollama | replay', 'ollama')
  .option('-m, --model <name>', 'model id')
  .option('-l, --limit <n>', 'maximum instances')
  .option('--lang <langs...>', 'filter by language')
  .option('--repos <repos...>', 'filter by org/repo')
  .option('--ids <ids...>', 'filter by instance id (org__repo-number)')
  .option('-w, --workdir <dir>', 'clone and workspace cache', '.sydes-bench')
  .option('-o, --out <dir>', 'run output directory', 'runs/bench')
  .option('--exec <mode>', 'local | docker:<image>', 'local')
  .option('--container-workdir <path>', 'repo path inside the instance image', '/workspace')
  .option('--max-turns <n>', 'turn budget per instance')
  .option('--include-tests', 'keep test-file changes in the patch')
  .option('-j, --workers <n>', 'instances to run concurrently', '1')
  .option('--max-cost <usd>', 'stop starting new instances past this spend')
  .option('--fresh', 're-run instances that already have a result')
  .action(async (opts) => {
    const instances = await loadDataset(opts.dataset, {
      langs: opts.lang?.map((l: string) => l.toLowerCase()),
      repos: opts.repos,
      ids: opts.ids,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });
    if (!instances.length) {
      console.error('no instances matched the filters');
      process.exitCode = 1;
      return;
    }

    const useGraph = opts.graph !== 'off';
    const provider = (opts.provider as ProviderName) ?? 'ollama';
    const arm = useGraph ? 'graph' : 'base';
    const outDir = path.join(path.resolve(opts.out), arm);

    const benchOptions: BenchOptions = {
      workdir: path.resolve(opts.workdir),
      outDir,
      graph: useGraph,
      provider: { provider, model: opts.model ?? DEFAULT_MODELS[provider] },
      config: agentConfigFrom(opts),
      exec: opts.exec === 'local' ? 'local' : (opts.exec as `docker:${string}`),
      containerWorkdir: opts.containerWorkdir,
      excludeTests: !opts.includeTests,
    };

    console.error(
      `[bench] ${instances.length} instance(s), arm=${arm}, exec=${benchOptions.exec}, ` +
        `workers=${opts.workers ?? 1}${opts.maxCost ? `, ceiling=$${opts.maxCost}` : ''}`,
    );

    const outcome = await runSweep(instances, {
      ...benchOptions,
      workers: opts.workers ? Number(opts.workers) : 1,
      maxCostUsd: opts.maxCost ? Number(opts.maxCost) : undefined,
      fresh: Boolean(opts.fresh),
      onProgress: (line) => console.error(`[bench] ${line}`),
    });

    const predictionsFile = path.join(outDir, 'predictions.jsonl');
    const summary = aggregate(arm, outcome.results.map((r) => r.metrics));
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

    console.error('');
    if (outcome.resumed) console.error(`[bench] ${outcome.resumed} instance(s) resumed, not re-run`);
    if (outcome.failed.length) {
      console.error(`[bench] ${outcome.failed.length} failed:`);
      for (const failure of outcome.failed.slice(0, 10)) {
        console.error(`         ${failure.instanceId}: ${failure.error}`);
      }
    }
    if (outcome.stoppedEarly) console.error(`[bench] stopped early — ${outcome.stoppedEarly}`);

    console.error(`[bench] ${outcome.results.length} prediction(s) → ${predictionsFile}`);
    console.error(`[bench] $${outcome.costUsd.toFixed(4)} spent; summary → ${path.join(outDir, 'summary.json')}`);
    console.error(
      `[bench] score with: sydes score --dataset ${opts.dataset.join(' ')} --predictions ${predictionsFile}`,
    );
  });

program
  .command('graph-eval')
  .description('Measure change-surface recall against gold patches — no model calls, no cost')
  .requiredOption('-d, --dataset <files...>', 'dataset JSONL file(s)')
  .option('-l, --limit <n>', 'maximum instances')
  .option('--lang <langs...>', 'filter by language')
  .option('--repos <repos...>', 'filter by org/repo')
  .option('-k, --k <values>', 'cutoffs to report', '5,10,20')
  .option('-w, --workdir <dir>', 'clone and workspace cache', '.sydes-bench')
  .option('-o, --out <file>', 'write the full JSON result')
  .option('--reuse', 're-use existing workspaces instead of re-cloning them')
  .option('--resume', 'skip instances already scored in the output file')
  .action(async (opts) => {
    const ks = String(opts.k)
      .split(',')
      .map((value: string) => Number(value.trim()))
      .filter((value: number) => Number.isFinite(value) && value > 0);

    const instances = await loadDataset(opts.dataset, {
      langs: opts.lang?.map((l: string) => l.toLowerCase()),
      repos: opts.repos,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });
    if (!instances.length) {
      console.error('no instances matched the filters');
      process.exitCode = 1;
      return;
    }

    // Results are written as they are produced, and an existing file is resumed from.
    //
    // A sweep is hours long and a single pathological repository can end the process outright
    // — an out-of-memory kill cannot be caught, so there is no in-process recovery to write.
    // Holding every result until the end meant one crash at instance 429 discarded 429
    // instances of work.
    // The progress file is append-only, one JSON object per instance. Rewriting the whole
    // summary after every instance would be quadratic in a run of a thousand — and the summary
    // is derived from these lines anyway, so it is written once at the end.
    const out = opts.out ? path.resolve(opts.out) : undefined;
    const progress = out ? `${out}.progress.jsonl` : undefined;
    const results: InstanceEval[] = [];
    const done = new Set<string>();

    if (progress && opts.resume) {
      try {
        for (const line of (await readFile(progress, 'utf8')).split('\n')) {
          if (!line.trim()) continue;
          try {
            const result = JSON.parse(line) as InstanceEval;
            results.push(result);
            done.add(result.instanceId);
          } catch {
            // A crash mid-write leaves a partial final line. Everything before it is intact.
          }
        }
        console.error(`[eval] resuming: ${done.size} instance(s) already scored`);
      } catch {
        console.error('[eval] no checkpoint found, starting fresh');
      }
    }
    if (progress) await mkdir(path.dirname(progress), { recursive: true });

    for (const [i, instance] of instances.entries()) {
      const id = `${instance.org}__${instance.repo}-${instance.number}`;
      if (done.has(id)) continue;
      process.stderr.write(`[eval] (${i + 1}/${instances.length}) ${id} … `);
      try {
        const result = await evaluateInstance(instance, {
          workdir: path.resolve(opts.workdir),
          k: ks,
          reuse: Boolean(opts.reuse),
        });
        results.push(result);
        if (progress) await appendFile(progress, `${JSON.stringify(result)}\n`);
        console.error(
          result.skipped
            ? `skipped (${result.skipped})`
            : `combined@|G|=${(result.recallAtG.combined * 100).toFixed(0)}% graph=${(result.recallAtG.graph * 100).toFixed(0)}% dir=${(result.recallAtG.directory * 100).toFixed(0)}% (${result.anchors} anchors)`,
        );
      } catch (error) {
        console.error(`failed: ${(error as Error).message}`);
      }
    }

    const summary = summarise(results, ks);
    if (out) {
      await writeFile(out, JSON.stringify(summary, null, 2));
      console.error(`[eval] ${opts.out}`);
    }
    console.log(`\n${renderEvalSummary(summary)}`);
  });

program
  .command('score')
  .description('Score a predictions file with the official Multi-SWE-bench harness (needs Docker)')
  .requiredOption('-d, --dataset <files...>', 'dataset JSONL file(s)')
  .requiredOption('--predictions <file>', 'predictions JSONL produced by `sydes bench`')
  .option('-w, --workdir <dir>', 'harness workdir', '.sydes-bench/harness')
  .option('-o, --out <dir>', 'harness output directory', 'runs/score')
  .option('--python <bin>', 'python executable', 'python3')
  .option('--max-workers <n>', 'parallel workers', '4')
  .action(async (opts) => {
    const report = await runOfficialHarness({
      workdir: opts.workdir,
      outputDir: opts.out,
      logDir: path.join(opts.out, 'logs'),
      datasetFiles: opts.dataset,
      patchFiles: [opts.predictions],
      python: opts.python,
      maxWorkers: Number(opts.maxWorkers),
    });

    if (!report.ok) {
      console.error(report.output);
      console.error(`\nharness did not produce ${report.reportPath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`resolved:   ${report.resolved}`);
    console.log(`unresolved: ${report.unresolved}`);
    console.log(`report:     ${report.reportPath}`);
  });

program
  .command('report')
  .description('Compare two runs or two benchmark arms')
  .requiredOption('-a, --baseline <dir>', 'baseline run directory (graph off)')
  .requiredOption('-b, --candidate <dir>', 'candidate run directory (graph on)')
  .option('-o, --out <file>', 'write the markdown report to a file')
  .action(async (opts) => {
    const baseline = await loadRuns(opts.baseline);
    const candidate = await loadRuns(opts.candidate);
    if (!baseline.length || !candidate.length) {
      console.error('no metrics.json found under one of the directories');
      process.exitCode = 1;
      return;
    }
    const markdown = renderReport(
      aggregate(path.basename(opts.baseline), baseline),
      aggregate(path.basename(opts.candidate), candidate),
    );
    if (opts.out) {
      await mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
      await writeFile(opts.out, `${markdown}\n`);
      console.error(`[report] ${opts.out}`);
    }
    console.log(markdown);
  });

/** Reads every metrics.json (or trace.jsonl) under a run directory. */
async function loadRuns(dir: string): Promise<RunMetrics[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const root = path.resolve(dir);
  const out: RunMetrics[] = [];

  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.name === 'metrics.json') {
        out.push(JSON.parse(await readFile(full, 'utf8')) as RunMetrics);
      } else if (entry.name === 'trace.jsonl') {
        const sibling = path.join(path.dirname(full), 'metrics.json');
        try {
          await stat(sibling);
        } catch {
          const events = (await readFile(full, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as TraceEvent);
          out.push(metricsFromEvents(events, path.basename(path.dirname(full))));
        }
      }
    }
  };

  await visit(root);
  return out;
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
