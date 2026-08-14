import { mkdtemp, rm, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexRepo, reindexFiles } from '../src/graph/indexer.js';
import { GraphQuery } from '../src/graph/query.js';
import { resolveTsImport } from '../src/graph/resolve.js';
import { LocalGraphProvider } from '../src/graph/provider.js';
import type { GraphStore } from '../src/graph/store.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');
const TS_FIXTURE = path.resolve('fixtures/ts-api');

function names(items: { node: { name: string; receiver?: string } }[]): string[] {
  return items.map((i) => (i.node.receiver ? `${i.node.receiver}.${i.node.name}` : i.node.name));
}

describe('go graph', () => {
  let store: GraphStore;
  let query: GraphQuery;

  beforeAll(async () => {
    store = await indexRepo(GO_FIXTURE);
    query = new GraphQuery(store);
  });

  it('indexes every go file and its symbols', () => {
    expect(store.files()).toContain('pkg/handler/pokedex.go');
    expect(store.symbolsInFile('service/pokemon.go').map((n) => n.name)).toEqual(
      expect.arrayContaining(['AddPokemon', 'ValidatePokemon', 'ListPokemon', 'Service']),
    );
  });

  /**
   * The example from the spec, as an executable assertion: expanding the handler file has to
   * surface the helpers, the service and the tests, each with a real path.
   */
  it('expands a handler file into its structural neighborhood', () => {
    const anchor = query.resolveAnchor('pkg/handler/pokedex.go');
    expect(anchor.status).toBe('file');
    const neighborhood = query.neighbors(anchor.node!);
    const groups = Object.fromEntries(neighborhood.groups.map((g) => [g.label, names(g.items)]));

    expect(groups['Defined here']).toEqual(['addPokemon', 'listPokemon']);
    expect(groups['Related code']).toEqual(
      expect.arrayContaining(['DecodePokemonJSON', 'RespondWithError', 'AddPokemon']),
    );
    expect(groups['Related tests']).toEqual(
      expect.arrayContaining(['Test_addPokemon', 'Test_listPokemon']),
    );

    const decode = neighborhood.groups
      .flatMap((g) => g.items)
      .find((i) => i.node.name === 'DecodePokemonJSON');
    expect(decode?.node.file).toBe('helpers/helpers.go');
    expect(decode?.confidence).toBe('exact');
  });

  it('resolves calls through package aliases exactly', () => {
    const anchor = query.resolveAnchor('addPokemon');
    expect(anchor.status).toBe('symbol');
    const callees = query.callees(anchor.node!.id);
    expect(names(callees)).toEqual(
      expect.arrayContaining(['DecodePokemonJSON', 'RespondWithError', 'AddPokemon']),
    );
    expect(callees.every((c) => c.confidence === 'exact')).toBe(true);
  });

  /** Case matters in Go: `addPokemon` and `AddPokemon` are unrelated functions. */
  it('does not conflate symbols that differ only by case', () => {
    const service = query.resolveAnchor('service/pokemon.go#AddPokemon');
    expect(service.status).toBe('symbol');
    const tests = query.testsFor(service.node!.id);
    expect(names(tests)).toEqual(['Test_AddPokemon']);
    expect(tests[0].node.file).toBe('service/pokemon_test.go');
  });

  /** Graph health: a fixture this small must resolve without guessing. */
  it('produces no heuristic edges on a well-formed repo', () => {
    expect(store.stats.heuristicEdges).toBe(0);
  });

  it('reports the change surface of an edit', () => {
    const impact = query.impact(['service/pokemon.go']);
    const groups = Object.fromEntries(impact.groups.map((g) => [g.label, names(g.items)]));
    expect(groups['Direct callers']).toEqual(expect.arrayContaining(['addPokemon', 'listPokemon']));
    expect(groups['Indirect callers']).toEqual(expect.arrayContaining(['Handler.Routes']));
    expect(impact.testFiles).toEqual(
      expect.arrayContaining(['service/pokemon_test.go', 'pkg/handler/pokedex_test.go']),
    );
  });

  /** Failed-exploration recovery: a wrong guess comes back with the real neighbours. */
  it('suggests real files for a path that does not exist', () => {
    const candidates = query.pathCandidates('server/handler/pokemon.go');
    expect(candidates.map((c) => c.file)).toContain('pkg/handler/pokedex.go');
    expect(candidates[0].file).toBe('pkg/handler/pokedex.go');
  });

  it('refuses to resolve an unknown anchor instead of guessing', () => {
    expect(query.resolveAnchor('TotallyMadeUpSymbol').status).toBe('notfound');
  });
});

describe('typescript graph', () => {
  let query: GraphQuery;

  beforeAll(async () => {
    query = new GraphQuery(await indexRepo(TS_FIXTURE));
  });

  it('resolves a method call through an imported class binding', () => {
    const handler = query.resolveAnchor('addPokemonHandler');
    const callees = query.callees(handler.node!.id);
    expect(names(callees)).toEqual(expect.arrayContaining(['PokemonService.addPokemon']));
    const method = callees.find((c) => c.node.name === 'addPokemon');
    expect(method?.node.file).toBe('src/services/pokemonService.ts');
    expect(method?.confidence).toBe('exact');
  });

  it('links describe blocks to the code they exercise', () => {
    const handler = query.resolveAnchor('addPokemonHandler');
    const tests = query.testsFor(handler.node!.id);
    expect(tests.map((t) => t.node.file)).toContain('tests/pokemon.test.ts');
  });

  it('maps ESM .js specifiers back to .ts sources', () => {
    const files = new Set(['src/lib/http.ts', 'src/index.ts', 'src/deep/index.ts']);
    expect(resolveTsImport('../lib/http.js', 'src/handlers/pokemon.ts', files, new Map())).toBe(
      'src/lib/http.ts',
    );
    expect(resolveTsImport('./deep', 'src/index.ts', files, new Map())).toBe('src/deep/index.ts');
    expect(resolveTsImport('node:fs', 'src/index.ts', files, new Map())).toBeUndefined();
  });
});

describe('incremental reindex', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sydes-graph-'));
    await cp(GO_FIXTURE, dir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('picks up a new symbol and its callers after an edit', async () => {
    const store = await indexRepo(dir);
    expect(store.findByName('NormalizeName')).toHaveLength(0);

    const helpers = path.join(dir, 'helpers/helpers.go');
    const original = await readFile(helpers, 'utf8');
    await writeFile(
      helpers,
      `${original}\n// NormalizeName trims a pokemon name.\nfunc NormalizeName(name string) string {\n\treturn name\n}\n`,
    );
    const pokedex = path.join(dir, 'pkg/handler/pokedex.go');
    const handlerSrc = await readFile(pokedex, 'utf8');
    await writeFile(
      pokedex,
      handlerSrc.replace('p, err := helpers.DecodePokemonJSON(r.Body)', 'p, err := helpers.DecodePokemonJSON(r.Body)\n\t_ = helpers.NormalizeName(p.Name)'),
    );

    await reindexFiles(store, ['helpers/helpers.go', 'pkg/handler/pokedex.go']);

    const query = new GraphQuery(store);
    const anchor = query.resolveAnchor('NormalizeName');
    expect(anchor.status).toBe('symbol');
    expect(names(query.callers(anchor.node!.id))).toEqual(['addPokemon']);
  });
});

describe('graph provider', () => {
  it('renders navigational text with paths on every line', async () => {
    const graph = new LocalGraphProvider(GO_FIXTURE);
    await graph.index();
    const result = graph.expand('pkg/handler/pokedex.go');

    expect(result.text).toContain('DecodePokemonJSON → helpers/helpers.go:');
    expect(result.surfacedFiles).toEqual(
      expect.arrayContaining(['helpers/helpers.go', 'service/pokemon.go']),
    );
    expect(result.ms).toBeLessThan(100);

    for (const line of result.text.split('\n').slice(2)) {
      if (line.startsWith('  ') && !line.startsWith('  …')) {
        expect(line, `line without a navigable path: ${line}`).toMatch(/→ \S+/);
      }
    }
  });

  /** Models pass absolute paths and `./` prefixes; a good anchor must not be lost to that. */
  it('normalises absolute and dot-prefixed anchors', async () => {
    const graph = new LocalGraphProvider(GO_FIXTURE);
    await graph.index();

    const relative = graph.expand('pkg/handler/pokedex.go').text;
    expect(graph.expand(`${GO_FIXTURE}/pkg/handler/pokedex.go`).text).toBe(relative);
    expect(graph.expand('./pkg/handler/pokedex.go').text).toBe(relative);
    expect(graph.impact([`${GO_FIXTURE}/service/pokemon.go`]).text).toContain('Direct callers');
  });

  /** "Which tests cover this file?" is the question agents actually ask. */
  it('answers relation queries for a file anchor, not just a symbol', async () => {
    const graph = new LocalGraphProvider(GO_FIXTURE);
    await graph.index();

    const tests = graph.testsFor('pkg/handler/pokedex.go');
    expect(tests.count).toBe(3);
    expect(tests.text).toMatch(/Test_addPokemon\s+→ pkg\/handler\/pokedex_test\.go:17/);

    const callers = graph.callers('helpers/helpers.go');
    expect(callers.text).toMatch(/addPokemon\s+→ pkg\/handler\/pokedex\.go:11/);
    // A file's own internal calls are not "callers of the file".
    expect(callers.text).not.toContain('RespondWithJSON');
  });

  it('turns a bad anchor into concrete alternatives, never a guess', async () => {
    const graph = new LocalGraphProvider(GO_FIXTURE);
    await graph.index();
    const result = graph.expand('server/handler/pokemon.go');
    expect(result.text).toContain('No graph anchor');
    expect(result.text).toContain('pkg/handler/pokedex.go');
  });
});
