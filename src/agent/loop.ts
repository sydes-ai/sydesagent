import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config.js';
import type { ExecutionEnvironment } from '../exec/types.js';
import type { GraphProvider } from '../graph/provider.js';
import { estimateCost } from '../llm/pricing.js';
import type { LLMProvider, Message, ToolCall } from '../llm/types.js';
import { Trace } from '../telemetry/trace.js';
import { walkRepo } from '../util/fs.js';
import { ContextManager } from './context.js';
import { Ledger } from './ledger.js';
import { systemPrompt, taskPrompt } from './prompt.js';
import { buildTools, toolSchemas, type Tool, type ToolContext } from './tools/index.js';
import { pathsMentioned } from './tools/util.js';

export interface AgentRunOptions {
  root: string;
  task: string;
  llm: LLMProvider;
  graph: GraphProvider;
  exec: ExecutionEnvironment;
  config: AgentConfig;
  runId?: string;
  /** Called after each turn, for CLI progress output. */
  onEvent?: (line: string) => void;
}

export interface AgentRunResult {
  runId: string;
  trace: Trace;
  ledger: Ledger;
  finalMessage: string;
  stopReason: 'finished' | 'max_turns' | 'token_budget' | 'model_stopped' | 'error';
  turns: number;
  editedFiles: string[];
  maxContextTokens: number;
  messages: Message[];
}

function summarise(root: string, fileCount: number, graph: GraphProvider): string {
  const stats = graph.enabled
    ? ` Code graph: ${graph.stats.files} indexed files, ${graph.stats.symbols} symbols, ${graph.stats.edges} relationships.`
    : '';
  return `${root} (${fileCount} files).${stats}`;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { root, task, llm, graph, exec, config } = options;
  const runId = options.runId ?? randomUUID().slice(0, 8);
  const trace = new Trace(runId);
  const ledger = new Ledger();
  const context = new ContextManager(config.contextTrimCeiling);
  const started = Date.now();

  const files = await walkRepo(root);
  const knownFiles = new Set(files);

  trace.emit({
    type: 'run_start',
    runId,
    task,
    repo: root,
    graph: graph.enabled,
    provider: llm.name,
    model: llm.model,
    ts: Date.now(),
  });

  // Anything the task itself names is the model's own knowledge, not a graph suggestion.
  const fromTask = pathsMentioned(task, knownFiles);
  if (fromTask.length) {
    ledger.noteSurfaced(fromTask, 'task', 0);
    trace.emit({ type: 'suggestion_surfaced', turn: 0, paths: fromTask, source: 'task' });
  }

  const tools = buildTools({
    graph: graph.enabled,
    allowBash: config.allowBash,
    compactGraphTools: config.compactGraphTools,
  });
  const byName = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
  const schemas = toolSchemas(tools);

  let messages: Message[] = [
    { role: 'system', content: systemPrompt({ graph: graph.enabled, repoSummary: summarise(root, files.length, graph) }) },
    { role: 'user', content: taskPrompt(task) },
  ];

  let turn = 0;
  let nudges = 0;
  let totalTokens = 0;
  let finalMessage = '';
  let stopReason: AgentRunResult['stopReason'] = 'max_turns';

  while (turn < config.maxTurns) {
    turn++;
    const trim = context.trim(messages);
    if (trim.trimmed) {
      messages = trim.messages;
      trace.emit({
        type: 'context_trim',
        turn,
        beforeTokens: trim.beforeTokens,
        afterTokens: trim.afterTokens,
        trimmedResults: trim.trimmed,
      });
    }
    const contextTokens = trim.afterTokens;

    let response;
    try {
      response = await llm.chat({
        messages,
        tools: schemas,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        cache: config.promptCache,
      });
    } catch (error) {
      finalMessage = `model call failed: ${(error as Error).message}`;
      stopReason = 'error';
      break;
    }

    const cacheRead = response.usage.cacheReadTokens ?? 0;
    const cacheWrite = response.usage.cacheWriteTokens ?? 0;
    totalTokens += response.usage.inputTokens + response.usage.outputTokens + cacheRead + cacheWrite;
    trace.emit({
      type: 'model_call',
      turn,
      latencyMs: response.latencyMs,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: estimateCost(llm.model, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      }),
      toolCalls: response.toolCalls.map((call) => call.name),
      stopReason: response.stopReason,
      contextTokens,
    });

    // Paths the model names on its own are attributed to the model, not to any tool - but
    // only if nothing has surfaced them already. First writer wins.
    if (response.text) {
      const mentioned = ledger.noteSurfaced(pathsMentioned(response.text, knownFiles), 'model', turn);
      if (mentioned.length) {
        trace.emit({ type: 'suggestion_surfaced', turn, paths: mentioned, source: 'model' });
      }
    }

    messages.push({
      role: 'assistant',
      content: response.text || undefined,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });

    if (!response.toolCalls.length) {
      if (nudges < config.maxNudges) {
        nudges++;
        options.onEvent?.(`turn ${turn}: no tool call, nudging (${nudges}/${config.maxNudges})`);
        messages.push({
          role: 'user',
          content:
            'That reply contained no tool call. Do not describe the calls you would make - make them. ' +
            'Investigate with read_file/grep, change code with edit_file, run tests with verify, ' +
            'and call finish when the task is complete.',
        });
        continue;
      }
      finalMessage = response.text;
      stopReason = 'model_stopped';
      options.onEvent?.(`turn ${turn}: model stopped without a tool call`);
      break;
    }

    let done = false;
    for (const call of response.toolCalls) {
      const result = await executeTool(call, byName, {
        root,
        graph,
        ledger,
        trace,
        exec,
        config,
        turn,
      });
      options.onEvent?.(`turn ${turn}: ${call.name}(${describeArgs(call)}) → ${result.content.length}b`);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
      if (result.done) {
        finalMessage = result.content;
        stopReason = 'finished';
        done = true;
      }
    }
    if (done) break;

    if (totalTokens > config.maxTotalTokens) {
      stopReason = 'token_budget';
      finalMessage = 'stopped: token budget exhausted';
      break;
    }
  }

  trace.emit({
    type: 'run_end',
    turn,
    reason: stopReason,
    ms: Date.now() - started,
    editedFiles: ledger.editedFiles(),
  });

  return {
    runId,
    trace,
    ledger,
    finalMessage,
    stopReason,
    turns: turn,
    editedFiles: ledger.editedFiles(),
    maxContextTokens: context.maxObserved,
    messages,
  };
}

function describeArgs(call: ToolCall): string {
  const primary = call.arguments.path ?? call.arguments.anchor ?? call.arguments.pattern ?? call.arguments.command ?? call.arguments.name;
  return typeof primary === 'string' ? primary.slice(0, 60) : '';
}

async function executeTool(
  call: ToolCall,
  byName: Map<string, Tool>,
  ctx: ToolContext,
): Promise<{ content: string; done?: boolean }> {
  const tool = byName.get(call.name);
  const started = Date.now();

  if (!tool) {
    const available = [...byName.keys()].join(', ');
    const content = `Unknown tool "${call.name}". Available tools: ${available}`;
    ctx.trace.emit({
      type: 'tool_call',
      turn: ctx.turn,
      name: call.name,
      args: call.arguments,
      latencyMs: 0,
      ok: false,
      resultBytes: content.length,
      note: 'unknown-tool',
    });
    return { content };
  }

  const parsed = tool.schema.safeParse(call.arguments);
  if (!parsed.success) {
    const content = `Invalid arguments for ${call.name}: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ')}`;
    ctx.trace.emit({
      type: 'tool_call',
      turn: ctx.turn,
      name: call.name,
      args: call.arguments,
      latencyMs: 0,
      ok: false,
      resultBytes: content.length,
      note: 'invalid-args',
    });
    return { content };
  }

  try {
    const result = await tool.run(parsed.data, ctx);
    ctx.trace.emit({
      type: 'tool_call',
      turn: ctx.turn,
      name: call.name,
      args: call.arguments,
      latencyMs: Date.now() - started,
      ok: !result.isError,
      resultBytes: result.content.length,
      note: result.note,
    });
    return { content: result.content, done: result.done };
  } catch (error) {
    const content = `${call.name} failed: ${(error as Error).message}`;
    ctx.trace.emit({
      type: 'tool_call',
      turn: ctx.turn,
      name: call.name,
      args: call.arguments,
      latencyMs: Date.now() - started,
      ok: false,
      resultBytes: content.length,
      note: 'exception',
    });
    return { content };
  }
}
