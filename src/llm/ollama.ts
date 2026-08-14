import { postJson, type HttpOptions } from './http.js';
import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from './types.js';

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: {
      id?: string;
      function: { name: string; arguments: Record<string, unknown> | string };
    }[];
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaMessages(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      // Ollama has no tool_call_id; the tool name is the only correlation it carries.
      return { role: 'tool', content: message.content ?? '', name: message.name };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(
    readonly model: string,
    private readonly baseUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    private readonly http: HttpOptions = {},
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(request.messages),
      stream: false,
      options: { temperature: request.temperature ?? 0, num_predict: request.maxTokens ?? 2048 },
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const data = await postJson<OllamaResponse>(`${this.baseUrl}/api/chat`, body, {}, this.http);

    const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}_${Date.now()}`,
      name: call.function.name,
      arguments:
        typeof call.function.arguments === 'string'
          ? safeParse(call.function.arguments)
          : (call.function.arguments ?? {}),
    }));

    return {
      text: data.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      stopReason: data.done_reason ?? 'stop',
      latencyMs: Date.now() - started,
    };
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return { __unparsed: raw };
  }
}
