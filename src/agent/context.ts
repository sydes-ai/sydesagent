import { estimateTokens } from '../util/text.js';
import type { Message } from '../llm/types.js';

/**
 * Keeps the conversation inside a budget. Old tool results are the first thing to go: their
 * value has usually already been extracted into the assistant's reasoning, while edits and
 * recent turns still carry live state.
 */
export class ContextManager {
  maxObserved = 0;

  constructor(private readonly budgetTokens: number) {}

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
   * Trims oldest tool results until the estimate fits. Never trims the system prompt, the
   * task, the last `keepRecent` messages, or any result recording an edit.
   */
  trim(messages: Message[], keepRecent = 10): Message[] {
    if (this.estimate(messages) <= this.budgetTokens) return messages;

    const trimmed = [...messages];
    const lastProtected = Math.max(0, trimmed.length - keepRecent);

    for (let i = 2; i < lastProtected; i++) {
      const message = trimmed[i];
      if (message.role !== 'tool') continue;
      const content = message.content ?? '';
      if (content.length < 400) continue;
      if (/^(Edited|Wrote) /.test(content)) continue;

      trimmed[i] = {
        ...message,
        content: `[earlier ${message.name ?? 'tool'} result trimmed to save context: ${content.length} characters. Re-run the tool if you need it again.]`,
      };
      if (this.estimate(trimmed) <= this.budgetTokens) break;
    }
    return trimmed;
  }
}
