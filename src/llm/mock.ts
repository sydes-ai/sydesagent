import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from './types.js';

export interface MockTurn {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  usage?: { inputTokens: number; outputTokens: number };
}

export type MockScript = (MockTurn | ((request: ChatRequest, turn: number) => MockTurn))[];

/**
 * Scripted provider for deterministic tests.
 *
 * Steps may be functions of the conversation so a test can assert on what the agent actually
 * saw - which is how the enrichment and ledger behaviours are verified without a live model.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly requests: ChatRequest[] = [];
  private turn = 0;

  constructor(
    private readonly script: MockScript,
    readonly model = 'mock-model',
  ) {}

  get callCount(): number {
    return this.turn;
  }

  /** Every tool result the agent fed back, in order. Convenient for assertions. */
  toolResults(): { name: string; content: string }[] {
    const last = this.requests[this.requests.length - 1];
    if (!last) return [];
    return last.messages
      .filter((m) => m.role === 'tool')
      .map((m) => ({ name: m.name ?? '', content: m.content ?? '' }));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script[this.turn];
    const index = this.turn;
    this.turn++;

    if (!step) {
      return {
        text: 'mock script exhausted',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'stop',
        latencyMs: 0,
      };
    }

    const turn = typeof step === 'function' ? step(request, index) : step;
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, i) => ({
      id: `mock_${index}_${i}`,
      name: call.name,
      arguments: call.arguments,
    }));

    return {
      text: turn.text ?? '',
      toolCalls,
      usage: turn.usage ?? {
        inputTokens: JSON.stringify(request.messages).length / 4,
        outputTokens: 32,
      },
      stopReason: toolCalls.length ? 'tool_calls' : 'stop',
      latencyMs: 0,
    };
  }
}
