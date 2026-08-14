import { LLMError } from './types.js';

export interface HttpOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST JSON with bounded retries. Retries only what is safe to retry. */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: HttpOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 3;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(response.status);
        throw new LLMError(
          `${url} responded ${response.status}: ${text.slice(0, 500)}`,
          response.status,
          retryable,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const retryable =
        (error instanceof LLMError && error.retryable) ||
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError'));
      if (!retryable || attempt === maxRetries) break;
      await sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new LLMError(String(lastError));
}
