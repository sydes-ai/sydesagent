import { z } from 'zod';
import { runCompile, runVerification } from '../verify.js';
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
    // Compile first: it is faster than the suite and says exactly which line is wrong.
    // A build that does not compile cannot produce a meaningful test result.
    const compiled = await runCompile(
      ctx.root,
      ctx.ledger.editedFiles(),
      ctx.graph,
      ctx.exec,
      ctx.config.compileTimeoutMs,
    );
    if (compiled && !compiled.unavailable) {
      ctx.trace.emit({
        type: 'compile_check',
        turn: ctx.turn,
        command: compiled.plan.command,
        scoped: compiled.plan.scoped,
        ok: compiled.ok,
        ms: compiled.ms,
      });
      if (!compiled.ok) {
        return {
          content: `$ ${compiled.plan.command}\n[BUILD FAILED in ${compiled.ms}ms — tests not run]\n${compiled.output}`,
          isError: true,
        };
      }
    }

    const result = await runVerification(
      ctx.root,
      ctx.ledger.editedFiles(),
      ctx.graph,
      ctx.exec,
      ctx.config.bashTimeoutMs,
      ctx.testBaseline,
    );

    if (!result) {
      return {
        content: 'No test runner detected for this repository; verify manually with bash.',
        isError: true,
      };
    }

    // Same rule as the compiler: a missing test runner is not a regression. Recording it as
    // one would tell the model its change broke the suite and would count a phantom failure
    // in the metrics.
    if (result.unavailable) {
      return {
        content:
          `No test runner available in this environment (\`${result.plan.command}\` could not be executed). ` +
          `This is not a test failure and says nothing about your change.`,
        isError: true,
        note: 'verify-unavailable',
      };
    }

    ctx.ledger.testRuns.push({ command: result.plan.command, ok: result.ok, turn: ctx.turn });
    ctx.trace.emit({
      type: 'test_run',
      turn: ctx.turn,
      command: result.plan.command,
      ok: result.ok,
      ms: result.ms,
      preexisting: result.preexisting.length,
    });

    const build = compiled ? `[build ok: ${compiled.plan.command}]\n` : '';
    const scope = result.plan.scoped
      ? `scoped: ${result.plan.reason}`
      : `unscoped: ${result.plan.reason}`;
    const covering = result.plan.testFiles.length
      ? `\nCovering tests: ${result.plan.testFiles.join(', ')}`
      : '';

    return {
      content: `${build}$ ${result.plan.command}\n[${scope}]${covering}\n[${result.ok ? 'PASS' : 'FAIL'} in ${result.ms}ms]\n${result.output}`,
      isError: !result.ok,
    };
  },
};
