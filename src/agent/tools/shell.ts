import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';

const TEST_COMMAND = /\b(go test|npm (run )?test|npx vitest|yarn test|pnpm test|jest|vitest|pytest|cargo test|mvn test|gradle test)\b/;

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Keep both ends: the command line context is at the top, the failure is at the bottom.
  const head = text.slice(0, Math.floor(limit * 0.3));
  const tail = text.slice(-Math.floor(limit * 0.7));
  return `${head}\n… [${text.length - limit} characters trimmed] …\n${tail}`;
}

export const bashTool: Tool<{ command: string; timeout_ms?: number }> = {
  name: 'bash',
  description:
    'Run a shell command in the repository root. Use it to build, run tests, or inspect the environment.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer' },
    },
    required: ['command'],
  },
  schema: z.object({ command: z.string(), timeout_ms: z.number().int().positive().optional() }),

  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.config.allowBash) {
      return { content: 'The bash tool is disabled for this run.', isError: true };
    }

    const result = await ctx.exec.run(args.command, {
      timeoutMs: args.timeout_ms ?? ctx.config.bashTimeoutMs,
    });

    if (TEST_COMMAND.test(args.command)) {
      ctx.ledger.testRuns.push({ command: args.command, ok: result.exitCode === 0, turn: ctx.turn });
      ctx.trace.emit({
        type: 'test_run',
        turn: ctx.turn,
        command: args.command,
        ok: result.exitCode === 0,
        ms: result.ms,
      });
    }

    const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const status = result.timedOut
      ? `timed out after ${result.ms}ms`
      : `exit ${result.exitCode} in ${result.ms}ms`;

    return {
      content: `$ ${args.command}\n[${status}]\n${clip(body.trim(), 12_000) || '(no output)'}`,
      isError: result.exitCode !== 0,
    };
  },
};

export const finishTool: Tool<{ summary: string }> = {
  name: 'finish',
  description:
    'Call when the task is complete. Summarise what you changed and what verification you ran.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  schema: z.object({ summary: z.string() }),

  async run(args): Promise<ToolResult> {
    return { content: args.summary, done: true };
  },
};
