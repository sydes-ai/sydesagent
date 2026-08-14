import { AnthropicProvider } from './anthropic.js';
import { MockProvider, type MockScript } from './mock.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { ReplayProvider } from './replay.js';
import type { LLMProvider } from './types.js';

export type ProviderName = 'openai' | 'anthropic' | 'ollama' | 'mock' | 'replay';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Cassette path; with `record` an inner live provider is wrapped. */
  cassette?: string;
  cassetteMode?: 'record' | 'replay';
  /** Only for the mock provider. */
  script?: MockScript;
  timeoutMs?: number;
  maxRetries?: number;
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-5',
  anthropic: 'claude-sonnet-5',
  ollama: 'llama3.1',
  mock: 'mock-model',
  replay: 'replayed',
};

function requireKey(value: string | undefined, envName: string): string {
  if (!value) {
    throw new Error(`${envName} is not set; export it or use --provider ollama|mock`);
  }
  return value;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const http = { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries };

  const build = (): LLMProvider => {
    switch (config.provider) {
      case 'openai':
        return new OpenAIProvider(
          config.model,
          requireKey(config.apiKey ?? process.env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
          config.baseUrl,
          http,
        );
      case 'anthropic':
        return new AnthropicProvider(
          config.model,
          requireKey(config.apiKey ?? process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
          config.baseUrl,
          http,
        );
      case 'ollama':
        return new OllamaProvider(config.model, config.baseUrl, http);
      case 'mock':
        return new MockProvider(config.script ?? [], config.model);
      case 'replay':
        if (!config.cassette) throw new Error('provider "replay" needs --cassette');
        return new ReplayProvider(config.cassette, 'replay');
    }
  };

  const provider = build();
  if (config.cassette && config.cassetteMode === 'record' && config.provider !== 'replay') {
    return new ReplayProvider(config.cassette, 'record', provider);
  }
  return provider;
}
