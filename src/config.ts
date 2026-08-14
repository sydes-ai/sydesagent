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
  /** Hard cap on footer size, in lines. */
  maxFooterLines: z.number().int().positive().default(12),
});

export const AgentConfigSchema = z.object({
  graph: z.boolean().default(true),
  maxTurns: z.number().int().positive().default(40),
  maxTotalTokens: z.number().int().positive().default(400_000),
  /** Context budget before old tool results get trimmed. */
  contextTokenBudget: z.number().int().positive().default(120_000),
  temperature: z.number().min(0).max(2).default(0),
  maxTokens: z.number().int().positive().default(4096),
  /** Truncation limit for a single file read, in lines. */
  maxReadLines: z.number().int().positive().default(600),
  maxGrepResults: z.number().int().positive().default(40),
  bashTimeoutMs: z.number().int().positive().default(120_000),
  allowBash: z.boolean().default(true),
  /**
   * How many times to correct a model that answers with prose instead of a tool call.
   * Smaller models do this often; without a nudge the run ends on turn one. Applied
   * identically in both arms so it cannot bias the comparison.
   */
  maxNudges: z.number().int().min(0).default(2),
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
    },
  };
}
