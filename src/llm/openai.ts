import { postJson, type HttpOptions } from './http.js';
import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from './types.js';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  choices: {
    message: { content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return { __unparsed: raw };
  }
}

/**
 * Reasoning-family models reject any temperature other than the default. Sending 0 - the right
 * choice everywhere else, because a benchmark wants determinism - fails the request outright.
 */
function supportsTemperature(model: string): boolean {
  return !/^(gpt-5|o1|o3|o4)/.test(model);
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    private readonly http: HttpOptions = {},
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(request.messages),
    };
    if (supportsTemperature(this.model)) body.temperature = request.temperature ?? 0;
    if (request.maxTokens) body.max_completion_tokens = request.maxTokens;
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

    const headers = { authorization: `Bearer ${this.apiKey}` };
    let data: OpenAIResponse;
    try {
      data = await postJson<OpenAIResponse>(`${this.baseUrl}/chat/completions`, body, headers, this.http);
    } catch (error) {
      // Model families change faster than this list; if the API names a parameter it will not
      // accept, drop that parameter and try once more rather than failing the whole run.
      const message = error instanceof Error ? error.message : '';
      const rejected = /Unsupported (?:value|parameter): '(\w+)'/.exec(message)?.[1];
      if (!rejected || !(rejected in body)) throw error;
      delete body[rejected];
      data = await postJson<OpenAIResponse>(`${this.baseUrl}/chat/completions`, body, headers, this.http);
    }

    const choice = data.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    }));

    // OpenAI caches prefixes over ~1024 tokens automatically and reports the hit here.
    // `prompt_tokens` includes the cached portion, so subtract it to get the billed remainder.
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = data.usage?.prompt_tokens ?? 0;

    return {
      text: choice?.message.content ?? '',
      toolCalls,
      usage: {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
      },
      stopReason: choice?.finish_reason ?? 'stop',
      latencyMs: Date.now() - started,
    };
  }
}
