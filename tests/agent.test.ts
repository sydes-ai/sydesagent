import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent/loop.js';
import { CORE_TOOLS } from '../src/agent/tools/index.js';
import { loadAgentConfig } from '../src/config.js';
import { LocalExec } from '../src/exec/local.js';
import { LocalGraphProvider, NullGraphProvider, type GraphProvider } from '../src/graph/provider.js';
import { MockProvider, type MockScript } from '../src/llm/mock.js';
import { HAS_GO } from './toolchain.js';
import type { AgentConfig } from '../src/config.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sydes-agent-'));
  await cp(GO_FIXTURE, workspace, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function run(script: MockScript, options: { graph?: boolean; config?: Partial<AgentConfig> } = {}) {
  const useGraph = options.graph ?? true;
  const graph: GraphProvider = useGraph ? new LocalGraphProvider(workspace) : new NullGraphProvider();
  await graph.index();

  const llm = new MockProvider(script);
  const result = await runAgent({
    root: workspace,
    task: 'Reject pokemon with a power above 1000 in the add flow.',
    llm,
    graph,
    exec: new LocalExec(workspace),
    config: loadAgentConfig({ graph: useGraph, ...options.config }),
  });
  return { result, llm, graph };
}

/** The tool result the model received for the Nth tool call it made. */
function toolResultAt(llm: MockProvider, index: number): string {
  const messages = llm.requests[llm.requests.length - 1].messages;
  const toolMessages = messages.filter((m) => m.role === 'tool');
  return toolMessages[index]?.content ?? '';
}

describe('agent loop', () => {
  it('runs tools, edits a file and finishes', async () => {
    const { result } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'service/pokemon.go' } }] },
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power >= 1000 {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'tightened the power check' } }] },
    ]);

    expect(result.stopReason).toBe('finished');
    expect(result.editedFiles).toEqual(['service/pokemon.go']);
    expect(result.finalMessage).toBe('tightened the power check');
    const updated = await readFile(path.join(workspace, 'service/pokemon.go'), 'utf8');
    expect(updated).toContain('if p.Power >= 1000 {');
  });

  /**
   * The core efficiency claim: re-reading an unchanged file must not re-spend context.
   */
  it('stubs a repeated read of an unchanged file', async () => {
    const { result, llm } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'helpers/helpers.go' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'helpers/helpers.go' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const first = toolResultAt(llm, 0);
    const second = toolResultAt(llm, 1);
    expect(first).toContain('func DecodePokemonJSON');
    expect(second).not.toContain('func DecodePokemonJSON');
    expect(second).toContain('unchanged since you read it on turn 1');
    expect(second.length).toBeLessThan(first.length / 4);

    expect(result.trace.ofType('repeat_read')).toHaveLength(1);
  });

  it('re-reads a file for real after it has been edited', async () => {
    const { llm } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'service/pokemon.go' } }] },
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'return ErrPowerTooHigh',
              new_string: 'return ErrPowerTooHigh // checked',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'service/pokemon.go' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const reread = toolResultAt(llm, 2);
    expect(reread).toContain('ErrPowerTooHigh // checked');
    expect(reread).not.toContain('unchanged since');
  });

  /**
   * Failed-exploration recovery: the wrong guess comes back with the real files, in the same
   * tool result, so recovery costs no extra model turn.
   */
  it('answers a failed read with real nearby files in the same turn', async () => {
    const { result, llm } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'server/handler/pokemon.go' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const failed = toolResultAt(llm, 0);
    expect(failed).toContain('File not found: server/handler/pokemon.go');
    expect(failed).toContain('Existing nearby structural candidates');
    expect(failed).toContain('pkg/handler/pokedex.go');

    const events = result.trace.ofType('failed_read');
    expect(events).toHaveLength(1);
    expect(events[0].recovered).toBe(true);
    // Recovery happened inside the failed call: only two model calls were made in total.
    expect(llm.callCount).toBe(2);
  });

  it('attaches the structural neighborhood to a first read', async () => {
    const { llm } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'pkg/handler/pokedex.go' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const body = toolResultAt(llm, 0);
    expect(body).toContain('--- structure (from the code graph');
    expect(body).toContain('helpers/helpers.go');
    expect(body).toContain('service/pokemon.go');
    expect(body).toContain('Related tests');
  });

  /**
   * Real models pass a defensive whole-file range (`start_line: 1, end_line: 400` for a
   * 48-line file) rather than omitting the arguments. Treating that as "wants a slice"
   * silently disabled the structural footer and repeat-read dedup in every live run, while
   * every test — which omitted the range — kept passing.
   */
  it('treats a range covering the whole file as a full read', async () => {
    const { result, llm } = await run([
      {
        toolCalls: [
          {
            name: 'read_file',
            arguments: { path: 'pkg/handler/pokedex.go', start_line: 1, end_line: 400 },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'read_file',
            arguments: { path: 'pkg/handler/pokedex.go', start_line: 1, end_line: 400 },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    // The footer fires, exactly as it would for an argument-free read.
    expect(toolResultAt(llm, 0)).toContain('--- structure (from the code graph');
    // And the second identical read is still deduplicated.
    expect(toolResultAt(llm, 1)).toContain('unchanged since you read it');
    expect(result.trace.ofType('graph_lookup').some((l) => l.kind === 'expand:auto')).toBe(true);
  });

  it('still treats a genuine slice as a slice', async () => {
    const { result, llm } = await run([
      {
        toolCalls: [
          { name: 'read_file', arguments: { path: 'helpers/helpers.go', start_line: 20, end_line: 30 } },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const body = toolResultAt(llm, 0);
    expect(body).toContain('lines 20-30 of');
    expect(body).not.toContain('--- structure (from the code graph');
    expect(result.trace.ofType('graph_lookup').some((l) => l.kind === 'expand:auto')).toBe(false);
  });

  it('does not repeat structural facts it has already shown', async () => {
    const { llm } = await run([
      { toolCalls: [{ name: 'graph_expand', arguments: { anchor: 'pkg/handler/pokedex.go' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'pkg/handler/pokedex.go' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const expansion = toolResultAt(llm, 0);
    const read = toolResultAt(llm, 1);
    expect(expansion).toContain('DecodePokemonJSON');
    // The read still returns the file, but not the relationships already on screen.
    expect(read).toContain('func addPokemon');
    expect(read).not.toContain('DecodePokemonJSON → helpers/helpers.go');
  });

  it('reports the change surface and covering tests after an edit', async () => {
    const { llm } = await run([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power >= 1000 {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const editResult = toolResultAt(llm, 0);
    expect(editResult).toContain('--- change surface (from the code graph) ---');
    expect(editResult).toContain('Direct callers');
    expect(editResult).toContain('pkg/handler/pokedex.go');
    expect(editResult).toContain('Tests covering the change');
  });

  it.skipIf(!HAS_GO)('runs tests through the execution environment and records them', async () => {
    const { result, llm } = await run([
      { toolCalls: [{ name: 'bash', arguments: { command: 'go test ./service/...' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const output = toolResultAt(llm, 0);
    expect(output).toContain('exit 0');
    const runs = result.trace.ofType('test_run');
    expect(runs).toHaveLength(1);
    expect(runs[0].ok).toBe(true);
  }, 120_000);
});

describe('correctness oracles', () => {
  /** The failure we watched a live model produce: an edit calling a symbol that never existed. */
  it('flags an invented symbol on the edit that introduces it', async () => {
    const { result, llm } = await run([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if err := ValidatePokemon(p); err != nil {',
              new_string: 'helpers.NormalizeName(p.Name)\n\tif err := ValidatePokemon(p); err != nil {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const editResult = toolResultAt(llm, 0);
    expect(editResult).toContain('--- symbol check ---');
    expect(editResult).toContain('helpers.NormalizeName');
    expect(editResult).toContain('no such symbol in package "helpers"');

    const flagged = result.trace.ofType('unknown_symbol');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('helpers.NormalizeName');
  }, 120_000);

  it('says nothing about a correct edit', async () => {
    const { result, llm } = await run([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power > 500 {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    expect(toolResultAt(llm, 0)).not.toContain('--- symbol check ---');
    expect(result.trace.ofType('unknown_symbol')).toHaveLength(0);
  }, 120_000);

  /** The compiler catches what the symbol checker cannot: bare value references. */
  it.skipIf(!HAS_GO)('reports a build failure the symbol check cannot see', async () => {
    const { result, llm } = await run([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power > maxAllowedPower {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const editResult = toolResultAt(llm, 0);
    expect(editResult).not.toContain('--- symbol check ---');
    expect(editResult).toContain('--- build FAILED');
    expect(editResult).toContain('undefined: maxAllowedPower');

    const checks = result.trace.ofType('compile_check');
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].scoped).toBe(true);
  }, 120_000);

  /** Both arms get an oracle; the graph only narrows what it covers. */
  it.skipIf(!HAS_GO)('compiles in the graph-off arm too, unscoped', async () => {
    const { result, llm } = await run(
      [
        {
          toolCalls: [
            {
              name: 'edit_file',
              arguments: {
                path: 'service/pokemon.go',
                old_string: 'if p.Power > 1000 {',
                new_string: 'if p.Power > maxAllowedPower {',
              },
            },
          ],
        },
        { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
      ],
      { graph: false },
    );

    expect(toolResultAt(llm, 0)).toContain('--- build FAILED');
    const checks = result.trace.ofType('compile_check');
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
  }, 120_000);

  it.skipIf(!HAS_GO)('refuses to run tests on a build that does not compile', async () => {
    const { llm } = await run([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'service/pokemon.go',
              old_string: 'if p.Power > 1000 {',
              new_string: 'if p.Power > maxAllowedPower {',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'verify', arguments: {} }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    const verifyResult = toolResultAt(llm, 1);
    expect(verifyResult).toContain('BUILD FAILED');
    expect(verifyResult).toContain('tests not run');
  }, 180_000);
});

describe('graph-off baseline', () => {
  it('is a working agent with no graph tools, prompt or events', async () => {
    const { result, llm } = await run(
      [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'pkg/handler/pokedex.go' } }] },
        { toolCalls: [{ name: 'read_file', arguments: { path: 'nope/missing.go' } }] },
        { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
      ],
      { graph: false },
    );

    const offered = llm.requests[0].tools?.map((t) => t.name) ?? [];
    expect(offered).toContain('read_file');
    expect(offered.filter((name) => name.startsWith('graph_'))).toHaveLength(0);

    const system = llm.requests[0].messages[0].content ?? '';
    expect(system).not.toContain('code graph');

    expect(toolResultAt(llm, 0)).not.toContain('--- structure');
    expect(toolResultAt(llm, 1)).not.toContain('Existing nearby structural candidates');

    expect(result.trace.ofType('graph_lookup')).toHaveLength(0);
    expect(result.trace.ofType('enrichment')).toHaveLength(0);
    expect(result.stopReason).toBe('finished');
  });

  it('offers the identical core toolset in both arms', async () => {
    const script: MockScript = [{ toolCalls: [{ name: 'finish', arguments: { summary: 'x' } }] }];
    const on = await run(script, { graph: true });
    const off = await run(script, { graph: false });

    // Compare against the declared core set rather than a name prefix: graph-only tools do
    // not all start with "graph_" (read_symbol does not), and a prefix rule would quietly
    // let one leak into the baseline comparison.
    const coreNames = new Set(CORE_TOOLS.map((t) => t.name));
    const core = (names: string[]) => names.filter((n) => coreNames.has(n)).sort();

    const onTools = on.llm.requests[0].tools!.map((t) => t.name);
    const offTools = off.llm.requests[0].tools!.map((t) => t.name);
    expect(core(onTools)).toEqual(core(offTools));
    // And the baseline gets nothing beyond the core set.
    expect(offTools.filter((n) => !coreNames.has(n))).toEqual([]);
  });
});

describe('tool robustness', () => {
  it('reports unknown tools and invalid arguments without crashing', async () => {
    const { result, llm } = await run([
      { toolCalls: [{ name: 'no_such_tool', arguments: {} }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 42 as unknown as string } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);

    expect(toolResultAt(llm, 0)).toContain('Unknown tool');
    expect(toolResultAt(llm, 1)).toContain('Invalid arguments');
    expect(result.stopReason).toBe('finished');
  });

  it('refuses to read outside the workspace', async () => {
    const { llm } = await run([
      { toolCalls: [{ name: 'read_file', arguments: { path: '../../etc/passwd' } }] },
      { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    ]);
    expect(toolResultAt(llm, 0)).toContain('outside the workspace');
  });

  it('nudges a model that answers with prose instead of a tool call', async () => {
    const { result, llm } = await run(
      [
        { text: 'Here is what I would do: read the service file.' },
        { toolCalls: [{ name: 'finish', arguments: { summary: 'nudged into acting' } }] },
      ],
      { config: { maxNudges: 1 } },
    );

    const secondRequest = llm.requests[1].messages;
    expect(secondRequest[secondRequest.length - 1].content).toContain('contained no tool call');
    expect(result.stopReason).toBe('finished');
  });

  it('stops once the nudge budget is spent', async () => {
    const { result } = await run([{ text: 'I think we are done here.' }], {
      config: { maxNudges: 0 },
    });
    expect(result.stopReason).toBe('model_stopped');
    expect(result.finalMessage).toBe('I think we are done here.');
  });

  it('honours the turn budget', async () => {
    const script: MockScript = Array.from({ length: 10 }, () => ({
      toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }],
    }));
    const { result } = await run(script, { config: { maxTurns: 3 } });
    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toBe(3);
  });
});
