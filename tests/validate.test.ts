import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo, reindexFiles } from '../src/graph/indexer.js';
import { newUnknowns, unknownSymbols } from '../src/graph/validate.js';
import type { GraphStore } from '../src/graph/store.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');
const TS_FIXTURE = path.resolve('fixtures/ts-api');

/**
 * The bar this validator has to clear before it is allowed near an agent: it must be silent
 * on code that is correct. A checker that cries wolf is worse than no checker, because the
 * model learns to ignore it.
 */
describe('false positives', () => {
  it('says nothing about a clean Go repository', async () => {
    const store = await indexRepo(GO_FIXTURE);
    const found = store.files().flatMap((file) => unknownSymbols(store, file));
    expect(found.map((f) => `${f.qualifier ?? ''}.${f.name}`)).toEqual([]);
  });

  it('says nothing about a clean TypeScript repository', async () => {
    const store = await indexRepo(TS_FIXTURE);
    const found = store.files().flatMap((file) => unknownSymbols(store, file));
    expect(found.map((f) => `${f.qualifier ?? ''}.${f.name}`)).toEqual([]);
  });

  /**
   * The specific things that made the first draft useless: method calls on values whose type
   * we do not infer. `json.NewDecoder(b).Decode()`, `mu.Lock()`, `expect(x).toBe(y)`.
   */
  it('never judges a method call on a value of unknown type', async () => {
    const store = await indexRepo(GO_FIXTURE);
    const helpers = store.facts.get('helpers/helpers.go')!;
    // These are real references in the fixture, and all are unresolvable by design.
    expect(helpers.refs.some((r) => r.name === 'Decode' && r.member)).toBe(true);
    expect(unknownSymbols(store, 'helpers/helpers.go')).toEqual([]);
  });

  it('treats parameters and local variables as bound, not missing', async () => {
    const store = await indexRepo(GO_FIXTURE);
    const facts = store.facts.get('service/pokemon.go')!;
    expect(facts.locals).toEqual(expect.arrayContaining(['p', 's', 'repo', 'err']));
  });
});

describe('catching invented symbols', () => {
  let workspace: string;
  let store: GraphStore;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'sydes-validate-'));
    await cp(GO_FIXTURE, workspace, { recursive: true });
    store = await indexRepo(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** The exact failure observed in a live run: a call to a function that does not exist. */
  it('flags a call into a real package for a symbol that is not there', async () => {
    const file = 'service/pokemon.go';
    const before = unknownSymbols(store, file);

    const abs = path.join(workspace, file);
    const source = await readFile(abs, 'utf8');
    await writeFile(
      abs,
      source.replace('if err := ValidatePokemon(p); err != nil {', 'helpers.NormalizeName(p.Name)\n\tif err := ValidatePokemon(p); err != nil {'),
    );
    await reindexFiles(store, [file]);

    const introduced = newUnknowns(before, unknownSymbols(store, file));
    expect(introduced).toHaveLength(1);
    expect(introduced[0]).toMatchObject({
      name: 'NormalizeName',
      qualifier: 'helpers',
      reason: 'not-in-package',
    });
  });

  it('flags an unqualified call to a function that exists nowhere', async () => {
    const file = 'service/pokemon.go';
    const before = unknownSymbols(store, file);

    const abs = path.join(workspace, file);
    const source = await readFile(abs, 'utf8');
    await writeFile(abs, source.replace('return ErrPowerTooHigh', 'reportOverpowered(p)\n\t\treturn ErrPowerTooHigh'));
    await reindexFiles(store, [file]);

    const introduced = newUnknowns(before, unknownSymbols(store, file));
    expect(introduced.map((u) => u.name)).toEqual(['reportOverpowered']);
    expect(introduced[0].reason).toBe('not-found');
  });

  it('offers real symbols as alternatives', async () => {
    const file = 'pkg/handler/pokedex.go';
    const abs = path.join(workspace, file);
    const source = await readFile(abs, 'utf8');
    await writeFile(abs, source.replace('helpers.DecodePokemonJSON(r.Body)', 'helpers.DecodePokemon(r.Body)'));
    await reindexFiles(store, [file]);

    const found = unknownSymbols(store, file);
    const decode = found.find((u) => u.name === 'DecodePokemon');
    expect(decode).toBeDefined();
    // Nothing named DecodePokemon exists, so candidates come from a fuzzy pass at render time.
    expect(decode!.reason).toBe('not-in-package');
  });

  /** Pre-existing noise in a file must never be attributed to the edit that follows it. */
  it('reports only what the edit introduced', async () => {
    const file = 'service/pokemon.go';
    const abs = path.join(workspace, file);
    const source = await readFile(abs, 'utf8');

    await writeFile(abs, source.replace('return ErrPowerTooHigh', 'alreadyBroken()\n\t\treturn ErrPowerTooHigh'));
    await reindexFiles(store, [file]);
    const before = unknownSymbols(store, file);
    expect(before.map((u) => u.name)).toEqual(['alreadyBroken']);

    const broken = await readFile(abs, 'utf8');
    await writeFile(abs, broken.replace('func ListPokemon', 'func alsoNew() { andAnotherOne() }\n\nfunc ListPokemon'));
    await reindexFiles(store, [file]);

    const introduced = newUnknowns(before, unknownSymbols(store, file));
    expect(introduced.map((u) => u.name)).toEqual(['andAnotherOne']);
  });

  it('stays silent when an edit is correct', async () => {
    const file = 'service/pokemon.go';
    const before = unknownSymbols(store, file);

    const abs = path.join(workspace, file);
    const source = await readFile(abs, 'utf8');
    await writeFile(abs, source.replace('if p.Power > 1000 {', 'if p.Power > 500 {'));
    await reindexFiles(store, [file]);

    expect(newUnknowns(before, unknownSymbols(store, file))).toEqual([]);
  });
});
