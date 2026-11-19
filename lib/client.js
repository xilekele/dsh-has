/**
 * Thin HTTP client for llama-server's OpenAI-compatible API.
 * Uses the global fetch available in Node 22+.
 */

export class ContextOverflowError extends Error {
  constructor(message, { promptTokens = 0, ctxSize = 0 } = {}) {
    super(message);
    this.name = 'ContextOverflowError';
    this.promptTokens = promptTokens;
    this.ctxSize = ctxSize;
    /** Retryable failures shrink the chunk and try again. */
    this.retryable = true;
  }
}

/**
 * A generation that ran past the request deadline. Callers treat it like a
 * context overflow: a smaller chunk usually finishes in time.
 */
export class ModelTimeoutError extends Error {
  constructor(message, timeoutMs) {
    super(message);
    this.name = 'ModelTimeoutError';
    this.timeoutMs = timeoutMs;
    this.retryable = true;
  }
}

export class HasClient {
  /**
   * @param {string} serverUrl e.g. http://127.0.0.1:8080
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  constructor(serverUrl, options = {}) {
    this.baseUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.signal = options.signal;
  }

  async #fetch(path, init, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('request timeout'));
    }, timeoutMs);
    const onAbort = () => controller.abort(this.signal?.reason);
    if (this.signal) {
      if (this.signal.aborted) controller.abort(this.signal.reason);
      else this.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut && !this.signal?.aborted) {
        throw new ModelTimeoutError(
          `Generation exceeded the ${Math.round(timeoutMs / 1000)}s request budget`,
          timeoutMs,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * How long one generation may take. A CPU-only build manages ~15 tokens/s;
   * budget 8 tokens/s so a legitimately long chunk is not killed, and keep the
   * configured timeout as the floor for short replies.
   */
  #deadlineFor(maxTokens) {
    if (!maxTokens) return this.timeoutMs;
    const pessimistic = Math.ceil((maxTokens / 8) * 1000);
    return Math.min(900_000, Math.max(this.timeoutMs, pessimistic));
  }

  /**
   * Send a chat completion and return the assistant reply text.
   * `maxTokens` bounds a degenerate generation loop; a truncated reply is
   * reported as ContextOverflowError so callers can shrink and retry.
   */
  async chat(messages, { maxTokens } = {}) {
    const body = maxTokens ? { messages, max_tokens: maxTokens } : { messages };
    let response;
    try {
      response = await this.#fetch(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.#deadlineFor(maxTokens),
      );
    } catch (error) {
      if (error instanceof ModelTimeoutError) throw error;
      throw new Error(`Cannot connect to llama-server at ${this.baseUrl}: ${error.message}`);
    }

    if (response.status === 400) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const detail = payload?.error;
      if (detail?.type === 'exceed_context_size_error') {
        throw new ContextOverflowError(
          `Prompt (${detail.n_prompt_tokens ?? '?'} tokens) exceeds context window (${detail.n_ctx ?? '?'} tokens)`,
          { promptTokens: detail.n_prompt_tokens ?? 0, ctxSize: detail.n_ctx ?? 0 },
        );
      }
      throw new Error(`llama-server returned 400: ${JSON.stringify(payload)}`);
    }

    if (!response.ok) {
      throw new Error(`llama-server returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    if (!choice) throw new Error('llama-server returned no completion choices');
    if (choice.finish_reason === 'length') {
      const usage = data.usage ?? {};
      throw new ContextOverflowError(
        `Output truncated: context full (prompt ${usage.prompt_tokens ?? '?'} + completion ${usage.completion_tokens ?? '?'})`,
        { promptTokens: usage.prompt_tokens ?? 0, ctxSize: usage.total_tokens ?? 0 },
      );
    }
    return choice.message?.content ?? '';
  }

  /** Tokenize via llama-server's /tokenize endpoint. */
  async tokenize(text) {
    let response;
    try {
      response = await this.#fetch(
        '/tokenize',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
        },
        60_000,
      );
    } catch (error) {
      throw new Error(`Cannot connect to llama-server at ${this.baseUrl} for tokenization: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`llama-server tokenize returned ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    return Array.isArray(data?.tokens) ? data.tokens : [];
  }

  async countTokens(text) {
    return (await this.tokenize(text)).length;
  }

  async health() {
    try {
      const response = await this.#fetch('/health', { method: 'GET' }, 5_000);
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

/** Cheap pre-server estimate, only used to size the slot pool. */
export function estimateTokensForPlanning(text) {
  if (!text) return 0;
  return Math.max(1, Math.floor(text.length * 0.5));
}
