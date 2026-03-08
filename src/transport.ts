import {
  APIError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  TransportError,
  UnauthorizedError,
  ValidationError
} from "./errors";
import { DEFAULT_RETRY_CONFIG, RetryConfig, computeDelayMs, shouldRetryError, shouldRetryStatus, sleep } from "./retry";

export interface TransportConfig {
  baseUrl: string;
  token: string | null;
  timeoutMs: number;
  retry: RetryConfig;
  fetchFn: typeof fetch;
  userAgent: string;
}

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retryable: boolean;
}

export function resolveConfig(input: {
  baseUrl?: string;
  token?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  userAgent?: string;
}): TransportConfig {
  const baseUrl = clean(input.baseUrl) ?? clean(process.env.PALI_BASE_URL);
  if (!baseUrl) {
    throw new ValidationError("baseUrl", "baseUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ValidationError("baseUrl", "baseUrl must include scheme and host");
  }
  if (!parsed.protocol || !parsed.host) {
    throw new ValidationError("baseUrl", "baseUrl must include scheme and host");
  }

  const token = clean(input.token ?? undefined) ?? clean(process.env.PALI_TOKEN);
  const timeoutMs = resolveTimeout(input.timeoutMs);
  const maxRetries = input.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new ValidationError("maxRetries", "maxRetries must be at least 1");
  }

  return {
    baseUrl: parsed.toString().replace(/\/$/, ""),
    token: token ?? null,
    timeoutMs,
    retry: {
      ...DEFAULT_RETRY_CONFIG,
      maxAttempts: maxRetries
    },
    fetchFn: input.fetchFn ?? fetch,
    userAgent: input.userAgent ?? "pali-client-js/0.1.0"
  };
}

export class Transport {
  private config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  setBearerToken(token: string | null | undefined): void {
    this.config = {
      ...this.config,
      token: clean(token ?? undefined) ?? null
    };
  }

  async requestJSON<T>(opts: RequestOptions): Promise<T> {
    const attempts = opts.retryable ? this.config.retry.maxAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const url = this.buildUrl(opts.path, opts.params);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.config.timeoutMs);

      try {
        const response = await this.config.fetchFn(url, {
          method: opts.method,
          headers: this.headers(opts.body !== undefined),
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.status >= 400) {
          if (attempt < attempts && shouldRetryStatus(response.status)) {
            const delay = computeDelayMs(attempt, this.config.retry, response.headers.get("Retry-After"));
            await sleep(delay);
            continue;
          }
          throw await parseApiError(response);
        }

        if (response.status === 204) {
          return undefined as T;
        }

        try {
          return (await response.json()) as T;
        } catch {
          throw new TransportError("invalid JSON response body");
        }
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof APIError) {
          throw err;
        }
        if (attempt < attempts && shouldRetryError(err)) {
          const delay = computeDelayMs(attempt, this.config.retry);
          await sleep(delay);
          continue;
        }
        if (shouldRetryError(err)) {
          throw new TransportError(String((err as Error).message ?? err));
        }
        throw new TransportError(`request failed: ${String((err as Error).message ?? err)}`);
      }
    }
    throw new TransportError("request failed");
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, `${this.config.baseUrl}/`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private headers(hasBody: boolean): Headers {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("User-Agent", this.config.userAgent);
    if (hasBody) {
      headers.set("Content-Type", "application/json");
    }
    if (this.config.token) {
      headers.set("Authorization", `Bearer ${this.config.token}`);
    }
    return headers;
  }
}

async function parseApiError(response: Response): Promise<APIError> {
  const body = await response.text();
  let message = response.statusText || "HTTP error";
  let code = deriveCode(response.status);
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; code?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      message = parsed.error.trim();
    } else if (typeof parsed.message === "string" && parsed.message.trim()) {
      message = parsed.message.trim();
    }
    if (typeof parsed.code === "string" && parsed.code.trim()) {
      code = parsed.code.trim();
    }
  } catch {
    // Keep plain body payload as-is when JSON parse fails.
  }
  const common = {
    statusCode: response.status,
    code,
    message,
    requestId: response.headers.get("X-Request-ID") ?? "",
    body
  };
  switch (response.status) {
    case 401:
      return new UnauthorizedError(common);
    case 403:
      return new ForbiddenError(common);
    case 404:
      return new NotFoundError(common);
    case 409:
      return new ConflictError(common);
    case 429:
      return new RateLimitError(common);
    default:
      return new APIError(common);
  }
}

function deriveCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    case 500:
      return "internal_error";
    case 503:
      return "unavailable";
    default:
      return "error";
  }
}

function resolveTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs === "number") {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ValidationError("timeoutMs", "timeoutMs must be > 0");
    }
    return timeoutMs;
  }
  const env = clean(process.env.PALI_TIMEOUT);
  if (!env) {
    return 15000;
  }
  const parsed = Number(env);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError("timeoutMs", "PALI_TIMEOUT must be a positive number");
  }
  return parsed;
}

function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError("date", `invalid date: ${value}`);
  }
  return d;
}
