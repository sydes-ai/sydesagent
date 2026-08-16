import { z } from 'zod';

/**
 * Enrichment switches are individually toggleable on purpose. Each one is a claim that the
 * graph removes work; the A/B report is the arbiter, and a middleware that turns out to add
 * context without removing turns must be droppable without touching the loop.
 */
export const EnrichmentSchema = z.object({
  /** E1: append a structural footer after a successful read. */
  readFooter: z.boolean().default(true),
  /** E2: turn a failed read into concrete nearby candidates. */
  failedReadRecovery: z.boolean().default(true),
  /** E3: offer graph symbol matches when a search returns nothing. */
  emptySearchHints: z.boolean().default(true),
  /** E4: summarise the change surface after an edit. */
  postEditImpact: z.boolean().default(true),
  /** E5: flag identifiers an edit introduced that refer to nothing real. */
  symbolCheck: z.boolean().default(true),
  /** Hard cap on footer size, in lines. */
  maxFooterLines: z.number().int().positive().default(12),
  /**
   * How many likely-to-change-together files to list after a read.
   *
   * Five because that is the cutoff the offline evaluation optimised: at k=5 the fused ranking
   * recovers 26% of the remaining change surface against a directory listing's 14%. Showing
   * more buys recall the model pays for in tokens on every read.
   */
  relatedFiles: z.number().int().nonnegative().default(5),
});

export const AgentConfigSchema = z.object({
  graph: z.boolean().default(true),
  maxTurns: z.number().int().positive().default(40),
  /**
   * Spend ceiling in fresh tokens — cache reads excluded; see the accumulator in `loop.ts`.
   */
  maxTotalTokens: z.number().int().positive().default(400_000),
  /**
   * Hard ceiling before old tool results get trimmed.
   *
   * Trimming rewrites history in place, which changes the cached prefix and invalidates every
   * cache entry from that point on. Since the re-sent prefix is ~87% of input and cached
   * tokens bill at a fraction of the input rate, growing context is usually cheaper than
   * trimming it. So this is a safety valve against overflowing the window, not a routine
   * economy measure - and every firing is recorded so the assumption stays testable.
   */
  contextTrimCeiling: z.number().int().positive().default(250_000),
  /** Ask providers to cache the stable prefix. Off only for caching ablations. */
  promptCache: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0),
  /**
   * Output cap per model call.
   *
   * 4096 silently broke reasoning models: their thinking bills as output, so gpt-5 spent an
   * entire turn producing 4096 tokens, hit `length`, and returned no tool call at all. The
   * turn was paid for and bought nothing. Reasoning needs headroom the answer itself does not.
   */
  maxTokens: z.number().int().positive().default(16_384),
  /** Truncation limit for a single file read, in lines. */
  maxReadLines: z.number().int().positive().default(600),
  maxGrepResults: z.number().int().positive().default(40),
  bashTimeoutMs: z.number().int().positive().default(120_000),
  allowBash: z.boolean().default(true),
  /**
   * Run the compiler or type checker after each edit.
   *
   * Catches contract breakage and invented symbols in seconds for zero model tokens, and is
   * far more precise about where the problem is than a failing test. Runs in both arms; the
   * graph only narrows which packages it covers.
   */
  compileAfterEdit: z.boolean().default(true),
  compileTimeoutMs: z.number().int().positive().default(120_000),
  /**
   * How many times to correct a model that answers with prose instead of a tool call.
   * Smaller models do this often; without a nudge the run ends on turn one. Applied
   * identically in both arms so it cannot bias the comparison.
   */
  maxNudges: z.number().int().min(0).default(2),
  /**
   * Expose the graph as one tool with a `relation` enum instead of six named tools.
   *
   * Tool schemas sit in the static prefix, which is re-sent on every turn - six graph tools
   * measured at ~380 tokens per turn, which on a ten-turn run cost more than the enrichment
   * they enabled. Collapsing recovers most of that, but models are measurably better at
   * choosing between distinctly named tools, so this is a flag with a measurement attached,
   * not a default.
   */
  compactGraphTools: z.boolean().default(false),
  enrichment: EnrichmentSchema.default({}),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type EnrichmentConfig = z.infer<typeof EnrichmentSchema>;

export function loadAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfigSchema.parse(overrides);
}

/** Every enrichment off - used by the graph-off arm and by ablation runs. */
export function withoutEnrichment(config: AgentConfig): AgentConfig {
  return {
    ...config,
    enrichment: {
      ...config.enrichment,
      readFooter: false,
      failedReadRecovery: false,
      emptySearchHints: false,
      postEditImpact: false,
      symbolCheck: false,
    },
  };
}
