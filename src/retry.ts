export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000
};

export function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 503;
}

export function shouldRetryError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "NetworkError";
  }
  return false;
}

export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) {
    return null;
  }
  return Math.max(0, target - Date.now());
}

export function computeDelayMs(
  attempt: number,
  config: RetryConfig,
  retryAfterHeader?: string | null
): number {
  const retryAfter = parseRetryAfterMs(retryAfterHeader ?? null);
  if (retryAfter !== null) {
    return Math.min(config.maxDelayMs, retryAfter);
  }
  const expo = Math.min(config.baseDelayMs * 2 ** Math.max(0, attempt - 1), config.maxDelayMs);
  return Math.random() * expo;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
