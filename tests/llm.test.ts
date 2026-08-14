import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { MockProvider } from '../src/llm/mock.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { OpenAIProvider } from '../src/llm/openai.js';
import type { Message, ToolSchema } from '../src/llm/types.js';

interface Captured {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let server: Server;
let baseUrl: string;
const captured: Captured[] = [];
/** Queue of canned responses; a number means "fail with this status once". */
let responses: (object | number)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      captured.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      const next = responses.shift();
      if (typeof next === 'number') {
        res.writeHead(next, { 'content-type': 'application/json' });
        res.end('{"error":"transient"}');
        return;
      }
      if (next && typeof next === 'object' && '__status' in next) {
        const failure = next as { __status: number; body: unknown };
        res.writeHead(failure.__status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const conversation: Message[] = [
  { role: 'system', content: 'you are sydes' },
  { role: 'user', content: 'fix the handler' },
  {
    role: 'assistant',
    content: 'looking',
    toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.go' } }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'package handler' },
];

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

describe('openai provider', () => {
  it('translates tool calls and results in both directions', async () => {
    captured.length = 0;
    responses = [
      {
        choices: [
          {
            message: {
              content: 'done',
              tool_calls: [
                { id: 'x1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"foo"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      },
    ];

    const provider = new OpenAIProvider('gpt-5', 'test-key', baseUrl);
    const response = await provider.chat({ messages: conversation, tools });

    const sent = captured[0].body;
    // OpenAI caches automatically; prompt_tokens includes the cached span, so the provider
    // subtracts it to leave the billed remainder.
    expect(response.usage.cacheReadTokens).toBe(0);
    expect(captured[0].headers.authorization).toBe('Bearer test-key');
    expect(sent.messages[2].tool_calls[0].function.arguments).toBe('{"path":"a.go"}');
    expect(sent.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'package handler',
    });
    expect(sent.tools[0].function.name).toBe('read_file');

    expect(response.toolCalls).toEqual([{ id: 'x1', name: 'grep', arguments: { pattern: 'foo' } }]);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 0 });
  });

  it('separates cached prefix tokens from billed input tokens', async () => {
    captured.length = 0;
    responses = [
      {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 9000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 8192 },
        },
      },
    ];

    const response = await new OpenAIProvider('gpt-5-mini', 'k', baseUrl).chat({
      messages: conversation,
    });

    expect(response.usage.inputTokens).toBe(808);
    expect(response.usage.cacheReadTokens).toBe(8192);
  });

  it('retries a transient failure and then succeeds', async () => {
    captured.length = 0;
    responses = [503, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }];

    const provider = new OpenAIProvider('gpt-5', 'k', baseUrl, { maxRetries: 2 });
    const response = await provider.chat({ messages: conversation });

    expect(captured).toHaveLength(2);
    expect(response.text).toBe('ok');
  });

  /** Reasoning models reject any temperature but the default; sending 0 fails the request. */
  it('omits temperature for reasoning models and keeps it for the rest', async () => {
    captured.length = 0;
    responses = [
      { choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: 'b' }, finish_reason: 'stop' }] },
    ];

    await new OpenAIProvider('gpt-5-mini', 'k', baseUrl).chat({ messages: conversation });
    await new OpenAIProvider('gpt-4.1', 'k', baseUrl).chat({ messages: conversation });

    expect(captured[0].body).not.toHaveProperty('temperature');
    expect(captured[1].body.temperature).toBe(0);
  });

  /** Model families change faster than any hard-coded list of unsupported parameters. */
  it('drops a parameter the API names as unsupported and retries once', async () => {
    captured.length = 0;
    responses = [
      {
        __status: 400,
        body: { error: { message: "Unsupported value: 'temperature' does not support 0" } },
      },
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
    ];

    const provider = new OpenAIProvider('gpt-4.1', 'k', baseUrl, { maxRetries: 0 });
    const response = await provider.chat({ messages: conversation });
    expect(response.text).toBe('ok');
    expect(captured).toHaveLength(2);
    expect(captured[0].body).toHaveProperty('temperature');
    expect(captured[1].body).not.toHaveProperty('temperature');
  });

  it('gives up on a non-retryable status', async () => {
    captured.length = 0;
    responses = [400];
    const provider = new OpenAIProvider('gpt-5', 'k', baseUrl, { maxRetries: 3 });
    await expect(provider.chat({ messages: conversation })).rejects.toThrow(/responded 400/);
    expect(captured).toHaveLength(1);
  });
});

describe('anthropic provider', () => {
  it('lifts the system prompt out and merges consecutive tool results', async () => {
    captured.length = 0;
    responses = [
      {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'tu1', name: 'graph_expand', input: { anchor: 'a.go' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 12 },
      },
    ];

    const provider = new AnthropicProvider('claude-sonnet-5', 'test-key', baseUrl);
    const response = await provider.chat({
      messages: [
        ...conversation,
        { role: 'tool', toolCallId: 'call_2', name: 'grep', content: 'no matches' },
      ],
      tools,
    });

    const sent = captured[0].body;
    expect(captured[0].headers['x-api-key']).toBe('test-key');
    expect(captured[0].headers['anthropic-version']).toBe('2023-06-01');
    // System is sent as a block array so the static prefix carries a cache breakpoint.
    expect(sent.system).toEqual([
      { type: 'text', text: 'you are sydes', cache_control: { type: 'ephemeral' } },
    ]);
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    // Both tool results collapse into a single user turn with two blocks.
    expect(sent.messages[2].content).toHaveLength(2);
    expect(sent.messages[2].content[0].type).toBe('tool_result');
    expect(sent.tools[0].input_schema.properties.path.type).toBe('string');

    expect(response.text).toBe('thinking');
    expect(response.toolCalls[0]).toEqual({
      id: 'tu1',
      name: 'graph_expand',
      arguments: { anchor: 'a.go' },
    });
    expect(response.usage).toEqual({
      inputTokens: 200,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  /**
   * The static prefix is over half of all input tokens and is re-sent every turn, so the
   * breakpoints are the single largest cost lever in the system.
   */
  it('places cache breakpoints on the static prefix and the newest turn', async () => {
    captured.length = 0;
    responses = [{ content: [], stop_reason: 'end_turn' }];

    await new AnthropicProvider('claude-sonnet-5', 'k', baseUrl).chat({ messages: conversation });

    const sent = captured[0].body;
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });

    const lastTurn = sent.messages[sent.messages.length - 1];
    const lastBlock = lastTurn.content[lastTurn.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });

    // At most four breakpoints are allowed per request.
    const marks = JSON.stringify(sent).match(/"cache_control"/g) ?? [];
    expect(marks.length).toBeLessThanOrEqual(4);
  });

  it('adds a second breakpoint so long turns stay inside the 20-block lookback', async () => {
    captured.length = 0;
    responses = [{ content: [], stop_reason: 'end_turn' }];

    // 30 alternating turns produce well over 20 content blocks.
    const long: Message[] = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 15; i++) {
      long.push({ role: 'user', content: `q${i}` });
      long.push({ role: 'assistant', content: `a${i}` });
    }

    await new AnthropicProvider('claude-sonnet-5', 'k', baseUrl).chat({ messages: long });

    const marks = JSON.stringify(captured[0].body.messages).match(/"cache_control"/g) ?? [];
    expect(marks.length).toBe(2);
  });

  it('omits cache_control entirely when caching is disabled', async () => {
    captured.length = 0;
    responses = [{ content: [], stop_reason: 'end_turn' }];

    await new AnthropicProvider('claude-sonnet-5', 'k', baseUrl).chat({
      messages: conversation,
      cache: false,
    });

    expect(captured[0].body.system).toBe('you are sydes');
    expect(JSON.stringify(captured[0].body)).not.toContain('cache_control');
  });

  it('reports cache reads and writes separately from uncached input', async () => {
    captured.length = 0;
    responses = [
      {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120,
          output_tokens: 10,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 400,
        },
      },
    ];

    const response = await new AnthropicProvider('claude-sonnet-5', 'k', baseUrl).chat({
      messages: conversation,
    });

    expect(response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 10,
      cacheReadTokens: 8000,
      cacheWriteTokens: 400,
    });
  });
});

describe('ollama provider', () => {
  it('reads tool calls and token counts from a chat response', async () => {
    captured.length = 0;
    responses = [
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'x.go' } } }],
        },
        done_reason: 'stop',
        prompt_eval_count: 55,
        eval_count: 9,
      },
    ];

    const provider = new OllamaProvider('llama3.1', baseUrl);
    const response = await provider.chat({ messages: conversation, tools });

    expect(captured[0].path).toBe('/api/chat');
    expect(captured[0].body.stream).toBe(false);
    expect(response.toolCalls[0].name).toBe('read_file');
    expect(response.toolCalls[0].arguments).toEqual({ path: 'x.go' });
    expect(response.usage).toEqual({ inputTokens: 55, outputTokens: 9 });
  });
});

describe('mock provider', () => {
  it('runs a script and exposes what the agent sent', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.go' } }] },
      (request) => ({ text: `saw ${request.messages.length} messages` }),
    ]);

    const first = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(first.toolCalls[0].name).toBe('read_file');

    const second = await provider.chat({ messages: conversation });
    expect(second.text).toBe('saw 4 messages');
    expect(provider.callCount).toBe(2);
  });
});
