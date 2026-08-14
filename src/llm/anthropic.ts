import { postJson, type HttpOptions } from './http.js';
import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from './types.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Anthropic puts the system prompt outside the message list and models tool results as
 * user-turn content blocks, so consecutive tool results have to be merged into one turn.
 */
function toAnthropicMessages(messages: Message[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');

  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      push('user', {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content ?? '',
      });
    } else if (message.role === 'assistant') {
      if (message.content) push('assistant', { type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        push('assistant', {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
    } else {
      push('user', { type: 'text', text: message.content ?? '' });
    }
  }
  return { system, messages: out };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    private readonly http: HttpOptions = {},
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const { system, messages } = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      temperature: request.temperature ?? 0,
    };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const data = await postJson<AnthropicResponse>(
      `${this.baseUrl}/v1/messages`,
      body,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      this.http,
    );

    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = data.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: block.name ?? '',
        arguments: block.input ?? {},
      }));

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      stopReason: data.stop_reason ?? 'end_turn',
      latencyMs: Date.now() - started,
    };
  }
}
