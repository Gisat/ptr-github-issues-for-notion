import * as core from '@actions/core';

const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 10000;
  const maxDelayMs = options.maxDelayMs ?? 90000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isRetryable = err instanceof Error && (
        RETRYABLE_STATUS_CODES.some(code =>
          err.message.includes(String(code))
        ) ||
        err.message.includes('Could not find database') ||
        err.message.includes('rate limit') ||
        err.message.includes('timeout') ||
        err.message.includes('timed out') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('Internal server error') ||
        err.message.includes('Too Many Requests')
      );

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }

      const jitter = Math.random() * 1000;
      const backoff = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);

      core.warn(`Attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${Math.round(backoff)}ms...`);
      await delay(backoff);
    }
  }

  throw lastError;
}
