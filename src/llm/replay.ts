import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatRequest, ChatResponse, LLMProvider } from './types.js';

interface Cassette {
  hash: string;
  response: ChatResponse;
}

function requestHash(request: ChatRequest): string {
  return createHash('sha1')
    .update(JSON.stringify({ messages: request.messages, tools: request.tools?.map((t) => t.name) }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Records a real provider's turns to a cassette, or replays them.
 *
 * This is how a transcript from a paid model becomes a deterministic regression test: record
 * once against the real API, then replay for free in CI with byte-identical behaviour.
 */
export class ReplayProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private cassettes: Cassette[] = [];
  private cursor = 0;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly mode: 'record' | 'replay',
    private readonly inner?: LLMProvider,
  ) {
    this.name = `replay:${mode}`;
    this.model = inner?.model ?? 'replayed';
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.cassettes = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Cassette);
    } catch {
      this.cassettes = [];
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    await this.load();
    const hash = requestHash(request);

    if (this.mode === 'replay') {
      const byPosition = this.cassettes[this.cursor];
      const cassette = byPosition?.hash === hash ? byPosition : this.cassettes.find((c) => c.hash === hash);
      if (!cassette) {
        throw new Error(
          `no cassette for request ${hash} at position ${this.cursor} in ${this.file}; re-record it`,
        );
      }
      this.cursor++;
      return cassette.response;
    }

    if (!this.inner) throw new Error('record mode needs an inner provider');
    const response = await this.inner.chat(request);
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ hash, response })}\n`);
    return response;
  }
}
