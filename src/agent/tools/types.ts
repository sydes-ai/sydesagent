import type { z } from 'zod';
import type { AgentConfig } from '../../config.js';
import type { ExecutionEnvironment } from '../../exec/types.js';
import type { GraphProvider } from '../../graph/provider.js';
import type { ToolSchema } from '../../llm/types.js';
import type { Trace } from '../../telemetry/trace.js';
import type { Ledger } from '../ledger.js';

export interface ToolContext {
  /** Absolute workspace root; all tool paths are relative to it. */
  root: string;
  graph: GraphProvider;
  ledger: Ledger;
  trace: Trace;
  exec: ExecutionEnvironment;
  config: AgentConfig;
  turn: number;
  /**
   * Test failures already present at the base commit.
   *
   * Threaded through the context rather than recomputed per call: the suite is expensive to
   * run, and every `run_tests` needs the same answer to the same question — which of these
   * failures did the agent actually cause. Undefined means the baseline was never established,
   * and verification falls back to the exit code.
   */
  testBaseline?: Set<string>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Set by `finish` to end the loop. */
  done?: boolean;
  note?: string;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  /** Sent to the model verbatim. Hand-written so the model sees exactly what we intend. */
  parameters: ToolSchema['parameters'];
  schema: z.ZodType<A>;
  /** Graph tools are omitted entirely from the baseline arm, prompt included. */
  graphOnly?: boolean;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
