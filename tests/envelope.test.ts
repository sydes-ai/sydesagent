import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ContextManager } from '../src/agent/context.js';
import { indexRepo } from '../src/graph/indexer.js';
import { envelopeFor, fileOutline, formatEnvelope } from '../src/graph/outline.js';
import { LocalGraphProvider } from '../src/graph/provider.js';
import type { GraphStore } from '../src/graph/store.js';
import type { Message } from '../src/llm/types.js';

const GO_FIXTURE = path.resolve('fixtures/go-pokedex');

let store: GraphStore;

beforeAll(async () => {
  store = await indexRepo(GO_FIXTURE);
});

describe('file outline', () => {
  it('shows what a file declares, and where, without the bodies', () => {
    const outline = fileOutline(store, 'service/pokemon.go');

    expect(outline).toContain('service/pokemon.go');
    expect(outline).toContain('package service');
    expect(outline).toContain('func AddPokemon');
    expect(outline).toContain('func ValidatePokemon');
    // Signatures only — no function bodies.
    expect(outline).not.toContain('return s.repo.Insert(p)');

    // And it is dramatically smaller than the file it describes.
    const source = require('node:fs').readFileSync(path.join(GO_FIXTURE, 'service/pokemon.go'), 'utf8');
    expect(outline.length).toBeLessThan(source.length);
  });

  it('is empty for a file the graph does not know', () => {
    expect(fileOutline(store, 'go.mod')).toBe('');
  });
});

describe('change envelope', () => {
  /**
   * One retrieval has to carry what several file reads would, or it trades bytes for turns —
   * and turns are the multiplier, since each one re-sends the whole conversation.
   */
  it('carries the symbol, its file skeleton and both directions of the contract', async () => {
    const parts = envelopeFor(store, 'AddPokemon')!;
    expect(parts).toBeDefined();
    expect(parts.node.name).toBe('AddPokemon');

    const source = await readFile(path.join(GO_FIXTURE, parts.node.file), 'utf8');
    const body = source
      .split('\n')
      .slice(parts.node.startLine - 1, parts.node.endLine)
      .join('\n');
    const rendered = formatEnvelope(parts, body);

    expect(rendered).toContain('Change envelope for AddPokemon');
    expect(rendered).toContain('--- file skeleton ---');
    expect(rendered).toContain('--- AddPokemon (full source) ---');
    expect(rendered).toContain('return s.repo.Insert(p)');

    // What it calls, with signatures, so an edit can honour the contract.
    expect(rendered).toContain('--- calls (signatures only) ---');
    expect(rendered).toContain('ValidatePokemon');
    // And who depends on it.
    expect(rendered).toContain('--- called by ---');
    expect(rendered).toContain('pkg/handler/pokedex.go');
  });

  it('is cheaper than reading every file it summarises', async () => {
    const parts = envelopeFor(store, 'AddPokemon')!;
    const files = new Set([
      parts.node.file,
      ...parts.calls.map((n) => n.file),
      ...parts.calledBy.map((n) => n.file),
    ]);

    let wholeFiles = 0;
    for (const file of files) {
      wholeFiles += (await readFile(path.join(GO_FIXTURE, file), 'utf8')).length;
    }

    const source = await readFile(path.join(GO_FIXTURE, parts.node.file), 'utf8');
    const body = source.split('\n').slice(parts.node.startLine - 1, parts.node.endLine).join('\n');
    const rendered = formatEnvelope(parts, body);

    expect(rendered.length).toBeLessThan(wholeFiles);
  });

  it('refuses a file anchor — an envelope is about one symbol', () => {
    expect(envelopeFor(store, 'service/pokemon.go')).toBeUndefined();
  });

  it('returns nothing for an anchor that does not exist', () => {
    expect(envelopeFor(store, 'NoSuchThing')).toBeUndefined();
  });
});

describe('outline instead of truncation', () => {
  /**
   * A read too long to send was previously cut at an arbitrary line: expensive *and*
   * misleading. An outline is smaller and shows the whole file's shape.
   */
  it('answers an over-long read with structure', async () => {
    const graph = new LocalGraphProvider(GO_FIXTURE);
    await graph.index();
    expect(graph.outline('helpers/helpers.go')).toContain('func DecodePokemonJSON');
  });
});

describe('outline-aware trimming', () => {
  it('keeps a trimmed file readable as its structure', () => {
    const big = 'x'.repeat(2000);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'tool', name: 'read_file', content: `service/pokemon.go (48 lines)\n${big}` },
      ...Array.from({ length: 12 }, (_, i): Message => ({ role: 'user', content: `filler ${i}` })),
    ];

    const withOutline = new ContextManager(100, () => 'func AddPokemon(...)').trim(messages);
    expect(withOutline.trimmed).toBe(1);
    expect(withOutline.messages[2].content).toContain('trimmed to its structure');
    expect(withOutline.messages[2].content).toContain('func AddPokemon');

    // Without an outline provider it still trims, just less usefully.
    const bare = new ContextManager(100).trim(messages);
    expect(bare.trimmed).toBe(1);
    expect(bare.messages[2].content).toContain('trimmed to save context');
  });

  it('does nothing below the ceiling', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];
    const outcome = new ContextManager(100_000).trim(messages);
    expect(outcome.trimmed).toBe(0);
    expect(outcome.messages).toBe(messages);
  });
});
