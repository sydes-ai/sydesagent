/**
 * One provider-neutral message and tool-call shape. Providers translate at their edge, so
 * the agent loop, the trace and the metrics never depend on whose API is behind them - which
 * is what makes an A/B run comparable across models.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content?: string;
  /** Assistant messages only. */
  toolCalls?: ToolCall[];
  /** Tool messages only: the call this result answers. */
  toolCallId?: string;
  /** Tool messages only: the tool that produced the result. */
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Ask the provider to cache the stable prefix. Providers that cache automatically ignore it;
   * Anthropic needs explicit breakpoints. Off only for ablation runs that measure its value.
   */
  cache?: boolean;
}

export interface Usage {
  /** Uncached input tokens, billed at full rate. */
  inputTokens: number;
  outputTokens: number;
  /** Prefix tokens served from cache, billed at a fraction of the input rate. */
  cacheReadTokens?: number;
  /** Prefix tokens written to cache this call, billed at a premium. */
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
