import { estimateTokens } from '../util/text.js';
import type { Message } from '../llm/types.js';

export interface TrimOutcome {
  messages: Message[];
  /** How many tool results were replaced with a stub. */
  trimmed: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Keeps the conversation inside the context window.
 *
 * This deliberately does as little as possible. Prompt caching bills a re-sent prefix at a
 * fraction of the input rate, but only while that prefix stays byte-identical - and trimming
 * rewrites history, invalidating the cache from the edit point onward. So trimming only fires
 * at a hard ceiling, and when it does, it takes a large bite (oldest results first) rather
 * than nibbling every turn and paying the cache reset repeatedly.
 */
/** First line of our own read_file results, e.g. `src/a.ts (48 lines)`. */
const READ_HEADER = /^(\S+) \((?:\d+ lines|lines \d+-\d+ of \d+)\)$/;

export class ContextManager {
  maxObserved = 0;

  constructor(
    private readonly ceilingTokens: number,
    /**
     * Turns a trimmed file body into its outline. Same cache cost as a bare stub - the
     * prefix is rewritten either way - but it keeps the file's shape instead of throwing it
     * away, so the model can decide whether to re-read without guessing.
     */
    private readonly outlineFor?: (file: string) => string,
  ) {}

  estimate(messages: Message[]): number {
    let total = 0;
    for (const message of messages) {
      total += estimateTokens(message.content ?? '');
      for (const call of message.toolCalls ?? []) {
        total += estimateTokens(JSON.stringify(call.arguments)) + 8;
      }
    }
    this.maxObserved = Math.max(this.maxObserved, total);
    return total;
  }

  /**
   * Trims oldest tool results until the estimate is comfortably under the ceiling. Never
   * touches the system prompt, the task, the last `keepRecent` messages, or any result
   * recording an edit.
   */
  trim(messages: Message[], keepRecent = 10): TrimOutcome {
    const beforeTokens = this.estimate(messages);
    if (beforeTokens <= this.ceilingTokens) {
      return { messages, trimmed: 0, beforeTokens, afterTokens: beforeTokens };
    }

    // Aim well below the ceiling: one expensive cache reset that buys many turns of headroom
    // beats a reset every turn.
    const target = this.ceilingTokens * 0.7;
    const trimmedMessages = [...messages];
    const lastProtected = Math.max(0, trimmedMessages.length - keepRecent);
    let trimmed = 0;

    for (let i = 2; i < lastProtected; i++) {
      const message = trimmedMessages[i];
      if (message.role !== 'tool') continue;
      const content = message.content ?? '';
      if (content.length < 400) continue;
      if (/^(Edited|Wrote) /.test(content)) continue;

      const file = READ_HEADER.exec(content.split('\n', 1)[0])?.[1];
      const outline = file ? this.outlineFor?.(file) : undefined;

      trimmedMessages[i] = {
        ...message,
        content: outline
          ? `[earlier read of ${file} trimmed to its structure to save context; re-read it or use read_symbol for a specific part]\n${outline}`
          : `[earlier ${message.name ?? 'tool'} result trimmed to save context: ${content.length} characters. Re-run the tool if you need it again.]`,
      };
      trimmed++;
      if (this.estimate(trimmedMessages) <= target) break;
    }

    return {
      messages: trimmedMessages,
      trimmed,
      beforeTokens,
      afterTokens: this.estimate(trimmedMessages),
    };
  }
}
