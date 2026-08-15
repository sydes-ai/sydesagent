import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isToolchainMissing, runCompile, runVerification } from '../src/agent/verify.js';
import type { ExecResult, ExecutionEnvironment } from '../src/exec/types.js';
import { LocalGraphProvider } from '../src/graph/provider.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

/** Stands in for a machine with no language toolchain, so this runs anywhere. */
class MissingToolchainExec implements ExecutionEnvironment {
  readonly kind = 'missing';
  readonly commands: string[] = [];
  async run(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return {
      stdout: '',
      stderr: '/bin/sh: 1: go: not found',
      exitCode: 127,
      timedOut: false,
      ms: 5,
    };
  }
}

/** A real failure: the toolchain ran and rejected the code. */
class BrokenBuildExec implements ExecutionEnvironment {
  readonly kind = 'broken';
  async run(): Promise<ExecResult> {
    return {
      stdout: '',
      stderr: 'service/pokemon.go:33:15: undefined: maxAllowedPower',
      exitCode: 2,
      timedOut: false,
      ms: 40,
    };
  }
}

let graph: LocalGraphProvider;

beforeAll(async () => {
  graph = new LocalGraphProvider(GO_FIXTURE);
  await graph.index();
});

describe('missing toolchain is not a failure', () => {
  it('classifies exit 127 and "not found" as unavailable', () => {
    const base = { stdout: '', timedOut: false, ms: 1 };
    expect(isToolchainMissing({ ...base, exitCode: 127, stderr: '' })).toBe(true);
    expect(isToolchainMissing({ ...base, exitCode: 1, stderr: 'sh: go: command not found' })).toBe(true);
    // A real compiler error must never be mistaken for an absent compiler.
    expect(
      isToolchainMissing({ ...base, exitCode: 2, stderr: 'undefined: maxAllowedPower' }),
    ).toBe(false);
  });

  it('marks a compile unavailable rather than failed when the compiler is absent', async () => {
    const result = await runCompile(GO_FIXTURE, ['service/pokemon.go'], graph, new MissingToolchainExec(), 5_000);
    expect(result?.ok).toBe(false);
    expect(result?.unavailable).toBe(true);
  });

  it('still reports a genuine build failure as a failure', async () => {
    const result = await runCompile(GO_FIXTURE, ['service/pokemon.go'], graph, new BrokenBuildExec(), 5_000);
    expect(result?.ok).toBe(false);
    expect(result?.unavailable).toBe(false);
    expect(result?.output).toContain('undefined: maxAllowedPower');
  });

  /**
   * The reason this matters: without the distinction, an environment with no test runner
   * tells the agent its change broke the suite, on every turn, and counts phantom failures
   * in the metrics.
   */
  it('marks verification unavailable rather than failed when the runner is absent', async () => {
    const result = await runVerification(GO_FIXTURE, ['service/pokemon.go'], graph, new MissingToolchainExec(), 5_000);
    expect(result?.ok).toBe(false);
    expect(result?.unavailable).toBe(true);
  });
});
