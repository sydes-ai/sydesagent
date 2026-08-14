import { z } from 'zod';
import { runVerification } from '../verify.js';
import type { Tool, ToolResult } from './types.js';

/**
 * Present in both arms. With the graph on it runs the tests that structurally cover the
 * edits; with it off it runs the project's default suite. That difference is the measurement.
 */
export const verifyTool: Tool<Record<string, never>> = {
  name: 'verify',
  description:
    'Run the tests that cover your changes and report the result. Use it after editing, before finishing.',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}).passthrough() as unknown as z.ZodType<Record<string, never>>,

  async run(_args, ctx): Promise<ToolResult> {
    const result = await runVerification(
      ctx.root,
      ctx.ledger.editedFiles(),
      ctx.graph,
      ctx.exec,
      ctx.config.bashTimeoutMs,
    );

    if (!result) {
      return {
        content: 'No test runner detected for this repository; verify manually with bash.',
        isError: true,
      };
    }

    ctx.ledger.testRuns.push({ command: result.plan.command, ok: result.ok, turn: ctx.turn });
    ctx.trace.emit({
      type: 'test_run',
      turn: ctx.turn,
      command: result.plan.command,
      ok: result.ok,
      ms: result.ms,
    });

    const scope = result.plan.scoped
      ? `scoped: ${result.plan.reason}`
      : `unscoped: ${result.plan.reason}`;
    const covering = result.plan.testFiles.length
      ? `\nCovering tests: ${result.plan.testFiles.join(', ')}`
      : '';

    return {
      content: `$ ${result.plan.command}\n[${scope}]${covering}\n[${result.ok ? 'PASS' : 'FAIL'} in ${result.ms}ms]\n${result.output}`,
      isError: !result.ok,
    };
  },
};
