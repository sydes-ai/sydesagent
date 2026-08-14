export function trigrams(value: string): Set<string> {
  const s = `  ${value.toLowerCase()} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams: cheap fuzzy match for names and paths. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** Splits an identifier into lowercase words: `addPokemonHandler` -> [add, pokemon, handler]. */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Rough token estimate; good enough for context budgeting and reporting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
