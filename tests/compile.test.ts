import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { condenseCompilerOutput, detectProject, planCompile } from '../src/agent/verify.js';
import { LocalGraphProvider, NullGraphProvider } from '../src/graph/provider.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let graph: LocalGraphProvider;

beforeAll(async () => {
  graph = new LocalGraphProvider(GO_FIXTURE);
  await graph.index();
});

describe('compile planning', () => {
  it('detects the compiler for a Go module', async () => {
    const project = await detectProject(GO_FIXTURE);
    expect(project.kind).toBe('go');
    expect(project.compileAll).toBe('go build ./...');
  });

  /**
   * The graph's contribution is scope: it knows the edit reaches the handler and main, so
   * those get type-checked too. The baseline only sees the package it edited.
   */
  it('widens the check to the packages the change reaches', async () => {
    const scoped = await planCompile(GO_FIXTURE, ['service/pokemon.go'], graph);
    expect(scoped?.scoped).toBe(true);
    expect(scoped?.command).toContain('./service/...');
    expect(scoped?.command).toContain('./pkg/handler/...');
  });

  it('still gives the baseline an oracle, scoped to the edited package', async () => {
    const baseline = await planCompile(GO_FIXTURE, ['service/pokemon.go'], new NullGraphProvider());
    expect(baseline?.command).toBe('go build ./service/...');
    expect(baseline?.reason).toContain('edited packages');
  });

  /**
   * `./...` means the entire module. Emitting it for a root-level file would make the
   * "scoped" command broader than the unscoped one - scoping that silently does the opposite.
   */
  it('treats a root-level file as the root package, not the whole module', async () => {
    const plan = await planCompile(GO_FIXTURE, ['main.go'], new NullGraphProvider());
    expect(plan?.command).toBe('go build .');
    expect(plan?.command).not.toContain('./...');
  });

  it('falls back to the whole project when nothing has been edited', async () => {
    const plan = await planCompile(GO_FIXTURE, [], graph);
    expect(plan?.command).toBe('go build ./...');
    expect(plan?.scoped).toBe(false);
  });

  it('has no compile step for a project without one', async () => {
    expect(await planCompile(path.resolve('fixtures'), ['x.go'], graph)).toBeUndefined();
  });
});

describe('compiler output', () => {
  it('keeps diagnostics and drops build chatter', () => {
    const raw = [
      'go: downloading example.com/dep v1.2.3',
      '# example.com/pokedex/service',
      'service/pokemon.go:33:15: undefined: maxAllowedPower',
    ].join('\n');

    const condensed = condenseCompilerOutput(raw);
    expect(condensed).toContain('undefined: maxAllowedPower');
    expect(condensed).not.toContain('downloading');
  });
});
