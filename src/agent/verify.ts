/**
 * Verification: requested behaviour -> changed code -> structurally affected code -> the
 * tests that reach it -> evidence.
 *
 * With the graph on, the test command is narrowed to the packages the change actually
 * reaches. With it off, the same tool runs the project's default suite. Both arms get the
 * tool, so "better test selection" is measured rather than assumed.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionEnvironment } from '../exec/types.js';
import type { GraphProvider } from '../graph/provider.js';

export type ProjectKind = 'go' | 'node' | 'rust' | 'maven' | 'gradle' | 'unknown';

export interface ProjectInfo {
  kind: ProjectKind;
  /** Command that runs the whole suite. */
  testAll: string;
  /** Command scoped to the given repo-relative files, or undefined if not supported. */
  testFor(files: string[]): string | undefined;
}

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await readFile(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

function goPackages(files: string[]): string[] {
  const dirs = new Set(files.map((f) => path.posix.dirname(f)).map((d) => (d === '.' ? '' : d)));
  return [...dirs].map((d) => (d ? `./${d}/...` : './...'));
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  if (await exists(root, 'go.mod')) {
    return {
      kind: 'go',
      testAll: 'go test ./...',
      testFor: (files) => {
        const packages = goPackages(files.filter((f) => f.endsWith('.go')));
        return packages.length ? `go test ${packages.join(' ')}` : undefined;
      },
    };
  }

  if (await exists(root, 'package.json')) {
    let raw = '{}';
    try {
      raw = await readFile(path.join(root, 'package.json'), 'utf8');
    } catch {
      /* keep defaults */
    }
    const pkg = JSON.parse(raw || '{}');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script: string = pkg.scripts?.test ?? '';

    if (deps.vitest || script.includes('vitest')) {
      return {
        kind: 'node',
        testAll: 'npx vitest run',
        testFor: (files) => (files.length ? `npx vitest run ${files.join(' ')}` : undefined),
      };
    }
    if (deps.jest || script.includes('jest')) {
      return {
        kind: 'node',
        testAll: 'npx jest',
        testFor: (files) => (files.length ? `npx jest ${files.join(' ')}` : undefined),
      };
    }
    return { kind: 'node', testAll: script ? 'npm test' : 'npm test', testFor: () => undefined };
  }

  if (await exists(root, 'Cargo.toml')) {
    return { kind: 'rust', testAll: 'cargo test', testFor: () => undefined };
  }
  if (await exists(root, 'pom.xml')) {
    return { kind: 'maven', testAll: 'mvn -q -B test', testFor: () => undefined };
  }
  if ((await exists(root, 'build.gradle')) || (await exists(root, 'build.gradle.kts'))) {
    return { kind: 'gradle', testAll: './gradlew test', testFor: () => undefined };
  }
  return { kind: 'unknown', testAll: '', testFor: () => undefined };
}

export interface VerificationPlan {
  command: string;
  /** Test files the graph believes cover the change. */
  testFiles: string[];
  scoped: boolean;
  reason: string;
}

export async function planVerification(
  root: string,
  editedFiles: string[],
  graph: GraphProvider,
): Promise<VerificationPlan | undefined> {
  const project = await detectProject(root);
  if (project.kind === 'unknown') return undefined;

  if (!editedFiles.length) {
    return {
      command: project.testAll,
      testFiles: [],
      scoped: false,
      reason: 'nothing edited yet; running the full suite',
    };
  }

  if (graph.enabled) {
    const impact = graph.impact(editedFiles);
    const scoped = project.testFor(impact.testFiles);
    if (scoped && impact.testFiles.length) {
      return {
        command: scoped,
        testFiles: impact.testFiles,
        scoped: true,
        reason: `${impact.testFiles.length} test file(s) structurally cover the change`,
      };
    }
  }

  // No graph, or the graph found no covering tests: fall back to the edited packages, then
  // to the whole suite. Never silently skip verification.
  const nearby = project.testFor(editedFiles);
  return {
    command: nearby ?? project.testAll,
    testFiles: [],
    scoped: Boolean(nearby),
    reason: nearby
      ? 'no structurally linked tests; running the tests near the edited files'
      : 'running the full suite',
  };
}

export interface VerificationResult {
  plan: VerificationPlan;
  ok: boolean;
  output: string;
  ms: number;
}

/** Keeps the failure, drops the noise: models do not need 400 lines of passing output. */
export function condenseTestOutput(output: string, ok: boolean, limit = 4000): string {
  if (ok) {
    const tail = output.trim().split('\n').slice(-8).join('\n');
    return tail || 'tests passed';
  }
  const lines = output.split('\n');
  const interesting = lines.filter((line) =>
    /(FAIL|--- FAIL|Error|error:|panic:|expected|Expected|✗|×|assert)/.test(line),
  );
  const body = (interesting.length ? interesting : lines).join('\n');
  return body.length > limit ? `${body.slice(0, limit)}\n… [output trimmed]` : body;
}

export async function runVerification(
  root: string,
  editedFiles: string[],
  graph: GraphProvider,
  exec: ExecutionEnvironment,
  timeoutMs: number,
): Promise<VerificationResult | undefined> {
  const plan = await planVerification(root, editedFiles, graph);
  if (!plan?.command) return undefined;

  await exec.sync?.(editedFiles);
  const result = await exec.run(plan.command, { timeoutMs });
  const ok = result.exitCode === 0;
  return {
    plan,
    ok,
    output: condenseTestOutput([result.stdout, result.stderr].filter(Boolean).join('\n'), ok),
    ms: result.ms,
  };
}
