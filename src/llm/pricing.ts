/**
 * Cost estimation.
 *
 * The A/B report treated a cached token and a fresh token as identical, which becomes actively
 * misleading the moment prompt caching is on: ~87% of our input is re-sent prefix, and cached
 * prefix bills at a fraction of the normal rate. Tokens are the mechanism; dollars are the
 * thing the project claims to reduce.
 *
 * Rates are USD per million tokens. Anthropic figures are list prices as of 2026-06-24;
 * cache reads bill at ~0.1x input and 5-minute cache writes at 1.25x input. Override any of
 * this with a JSON file via SYDES_PRICING when rates change.
 */
import { readFileSync } from 'node:fs';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M tokens read from cache. */
  cacheRead: number;
  /** USD per 1M tokens written to cache. */
  cacheWrite: number;
}

function anthropic(input: number, output: number): ModelPrice {
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

/** OpenAI publishes a cached-input rate directly; it is not a multiple of the input rate. */
function openai(input: number, output: number, cachedInput: number): ModelPrice {
  return { input, output, cacheRead: cachedInput, cacheWrite: input };
}

const BUILTIN_PRICES: Record<string, ModelPrice> = {
  // Anthropic (list, 2026-06-24)
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-sonnet-5': anthropic(3, 15),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
  'claude-fable-5': anthropic(10, 50),

  // OpenAI. Verify against current published rates before quoting these in a write-up.
  'gpt-5': openai(1.25, 10, 0.125),
  'gpt-5-mini': openai(0.25, 2, 0.025),
  'gpt-5-nano': openai(0.05, 0.4, 0.005),
  'gpt-5-codex': openai(1.25, 10, 0.125),
  'gpt-4.1': openai(2, 8, 0.5),
  'gpt-4.1-mini': openai(0.4, 1.6, 0.1),

  // Local models cost nothing per token; wall-clock is the real budget there.
  'llama3.1': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'deepseek-coder': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'mock-model': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

let overrides: Record<string, ModelPrice> | undefined;

function loadOverrides(): Record<string, ModelPrice> {
  if (overrides) return overrides;
  overrides = {};
  const file = process.env.SYDES_PRICING;
  if (file) {
    try {
      overrides = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModelPrice>;
    } catch {
      /* a broken override file must not take the run down; built-ins still apply */
    }
  }
  return overrides;
}

/** Longest-prefix match, so `gpt-5-mini-2026-08-07` resolves to the `gpt-5-mini` entry. */
export function priceFor(model: string): ModelPrice | undefined {
  const table = { ...BUILTIN_PRICES, ...loadOverrides() };
  if (table[model]) return table[model];
  const keys = Object.keys(table)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length);
  return keys.length ? table[keys[0]] : undefined;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * USD for one call. Returns 0 for unknown models rather than guessing - a wrong number in a
 * comparison table is worse than a visibly absent one, and `costKnown` says which it is.
 */
export function estimateCost(model: string, usage: CostInput): number {
  const price = priceFor(model);
  if (!price) return 0;
  const million = 1_000_000;
  return (
    (usage.inputTokens * price.input) / million +
    (usage.outputTokens * price.output) / million +
    ((usage.cacheReadTokens ?? 0) * price.cacheRead) / million +
    ((usage.cacheWriteTokens ?? 0) * price.cacheWrite) / million
  );
}

export function costKnown(model: string): boolean {
  return priceFor(model) !== undefined;
}
