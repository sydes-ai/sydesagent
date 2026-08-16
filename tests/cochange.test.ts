import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoChange, coChangeNeighbours } from '../src/graph/cochange.js';
import { LocalExec } from '../src/exec/local.js';

let repo: string;

/** One commit touching exactly the named files. */
async function commit(files: string[], message: string): Promise<void> {
  const git = new LocalExec(repo);
  for (const file of files) await writeFile(path.join(repo, file), `${message}\n`);
  await git.run(`git add -A && git commit -q -m ${JSON.stringify(message)}`);
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'sydes-cochange-'));
  const git = new LocalExec(repo);
  await git.run('git init -q -b main');
  await git.run('git config user.email sydes@test.local && git config user.name Sydes');

  // `pair-a` and `pair-b` move together in small, focused commits.
  for (let i = 0; i < 4; i++) await commit(['pair-a.ts', 'pair-b.ts'], `focused ${i}`);
  // `bulk-*` only ever move in one sweeping commit alongside everything else.
  const bulk = Array.from({ length: 40 }, (_, i) => `bulk-${i}.ts`);
  await commit([...bulk, 'pair-a.ts'], 'sweeping refactor');
}, 120_000);

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('co-change', () => {
  /**
   * The 25-file cutoff this replaces was a cliff: a commit of 26 files counted for nothing, so
   * a repository whose ordinary commits are large scored zero co-change and the signal simply
   * vanished. Weighting by commit size keeps the evidence and discounts it instead.
   */
  it('keeps large commits as weak evidence instead of discarding them', async () => {
    const index = await buildCoChange(repo);
    const neighbours = coChangeNeighbours(index, 'pair-a.ts', 50);
    const names = neighbours.map((n) => n.file);

    // The sweeping commit is still visible — under the old cutoff it was not.
    expect(names).toContain('bulk-0.ts');

    // But four focused commits outweigh one sweeping one.
    expect(names[0]).toBe('pair-b.ts');
    const pair = neighbours.find((n) => n.file === 'pair-b.ts')!;
    const bulk = neighbours.find((n) => n.file === 'bulk-0.ts')!;
    expect(pair.score).toBeGreaterThan(bulk.score * 5);
  }, 120_000);

  it('reports nothing for a file with no history and never divides by zero', async () => {
    const index = await buildCoChange(repo);
    expect(coChangeNeighbours(index, 'never-committed.ts', 10)).toEqual([]);
    expect(index.totalWeight).toBeGreaterThan(0);
    for (const { score } of coChangeNeighbours(index, 'pair-a.ts', 50)) {
      expect(Number.isFinite(score)).toBe(true);
    }
  }, 120_000);

  it('returns nothing outside a git repository rather than throwing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'sydes-nogit-'));
    try {
      const index = await buildCoChange(empty);
      expect(index.totalWeight).toBe(0);
      expect(coChangeNeighbours(index, 'anything.ts', 10)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 120_000);
});
