import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from '../agent/loop.js';
import { runCompile, runVerification } from '../agent/verify.js';
import type { AgentConfig } from '../config.js';
import { DockerExec, copyOut, startContainer } from '../exec/docker.js';
import { LocalExec } from '../exec/local.js';
import type { ExecutionEnvironment } from '../exec/types.js';
import { LocalGraphProvider, NullGraphProvider, type GraphProvider } from '../graph/provider.js';
import { createProvider, type ProviderConfig } from '../llm/registry.js';
import { computeMetrics, type RunMetrics } from '../telemetry/metrics.js';
import { instanceId, taskText, type BenchInstance } from './dataset.js';
import { toPrediction, type Prediction } from './predictions.js';
import { extractPatch, prepareWorkspace } from './workspace.js';

export interface BenchOptions {
  workdir: string;
  outDir: string;
  graph: boolean;
  provider: ProviderConfig;
  config: AgentConfig;
  /**
   * `docker:<image>` runs commands inside the instance image; `local` runs them on the host.
   *
   * The image may be a template — `{org}`, `{repo}`, `{number}` and `{id}` are substituted per
   * instance. The official harness builds one image per pull request, so a single fixed name
   * cannot serve a sweep, and `local` silently cannot build most repositories at all.
   */
  exec: 'local' | `docker:${string}`;
  /** Repository path inside the instance image, when using docker exec. */
  containerWorkdir?: string;
  excludeTests?: boolean;
  onEvent?: (line: string) => void;
}

export interface InstanceResult {
  instanceId: string;
  prediction: Prediction;
  metrics: RunMetrics;
  patchBytes: number;
  error?: string;
  verified?: boolean;
}

/**
 * Per-instance image names, because the official images are per pull request.
 *
 * Substitution rather than a hard-coded naming rule: the harness's own convention varies with
 * the org and repo, and guessing it wrong fails at container start with a pull error that
 * looks like a network problem. Passing the template explicitly keeps the rule where the
 * person who ran `docker images` can see it.
 */
export function resolveImage(template: string, instance: BenchInstance): string {
  return template
    .replaceAll('{org}', String(instance.org))
    .replaceAll('{repo}', String(instance.repo))
    .replaceAll('{number}', String(instance.number))
    .replaceAll('{id}', instanceId(instance));
}

async function buildExec(
  options: BenchOptions,
  root: string,
  instance: BenchInstance,
): Promise<{ exec: ExecutionEnvironment; cleanup: () => Promise<void> }> {
  if (options.exec === 'local') {
    return { exec: new LocalExec(root), cleanup: async () => {} };
  }
  const image = resolveImage(options.exec.slice('docker:'.length), instance);
  const workdir = options.containerWorkdir ?? '/workspace';
  const handle = await startContainer(image, workdir, root);
  // The image holds the prepared repository and its dependencies; take the host copy from it
  // so the graph indexes exactly what the tests will run against.
  await copyOut(handle.container, workdir, root);
  return {
    exec: handle.exec,
    cleanup: async () => {
      await (handle.exec as DockerExec).dispose();
    },
  };
}

export async function runInstance(
  instance: BenchInstance,
  options: BenchOptions,
): Promise<InstanceResult> {
  const workspace = await prepareWorkspace(instance, { workdir: options.workdir });
  const { exec, cleanup } = await buildExec(options, workspace.root, instance);

  try {
    const graph: GraphProvider = options.graph
      ? new LocalGraphProvider(workspace.root)
      : new NullGraphProvider();
    await graph.index();

    // A freshly cloned repo often cannot build: dependencies are not fetched, toolchains
    // differ, generated files are missing. If the compile oracle fires in that state it
    // reports pre-existing breakage as the agent's fault on every single edit — worse than
    // having no oracle at all. So check the baseline first and switch it off if it is dirty.
    let config = options.config;
    if (config.compileAfterEdit) {
      const baseline = await runCompile(workspace.root, [], graph, exec, config.compileTimeoutMs);
      if (baseline && !baseline.ok) {
        config = { ...config, compileAfterEdit: false };
        options.onEvent?.(
          baseline.unavailable
            ? `compile oracle disabled: no compiler available in this environment`
            : `compile oracle disabled: ${workspace.instanceId} does not build at its base commit`,
        );
      }
    }

    const llm = createProvider(options.provider);
    const result = await runAgent({
      root: workspace.root,
      task: taskText(instance),
      llm,
      graph,
      exec,
      config,
      runId: `${workspace.instanceId}-${options.graph ? 'graph' : 'base'}`,
      onEvent: options.onEvent,
    });

    // A final verification pass, so every run has evidence attached even if the model
    // forgot to ask for it.
    if (result.editedFiles.length && !result.ledger.testRuns.length) {
      const verification = await runVerification(
        workspace.root,
        result.editedFiles,
        graph,
        exec,
        config.bashTimeoutMs,
      );
      if (verification) {
        result.trace.emit({
          type: 'test_run',
          turn: result.turns,
          command: verification.plan.command,
          ok: verification.ok,
          ms: verification.ms,
        });
      }
    }

    const patch = await extractPatch(workspace.root, { excludeTests: options.excludeTests });
    const metrics = computeMetrics(result.trace, { maxContextTokens: result.maxContextTokens });

    const runDir = path.join(options.outDir, workspace.instanceId);
    await mkdir(runDir, { recursive: true });
    await result.trace.write(path.join(runDir, 'trace.jsonl'));
    await writeFile(path.join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await writeFile(path.join(runDir, 'patch.diff'), patch);

    return {
      instanceId: workspace.instanceId,
      prediction: toPrediction(instance, patch),
      metrics,
      patchBytes: patch.length,
      verified: metrics.verified,
    };
  } finally {
    await cleanup();
  }
}
