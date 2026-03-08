import { describe, expect, test, vi } from "vitest";

import { computeDelayMs, parseRetryAfterMs, shouldRetryError, shouldRetryStatus } from "../src/retry";

describe("retry", () => {
  test("retries only 429 and 503 statuses", () => {
    expect(shouldRetryStatus(429)).toBe(true);
    expect(shouldRetryStatus(503)).toBe(true);
    expect(shouldRetryStatus(500)).toBe(false);
  });

  test("parses retry-after seconds", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1500);
  });

  test("uses full jitter backoff", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeDelayMs(3, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 });
    expect(delay).toBe(400);
  });

  test("retryable network errors", () => {
    expect(shouldRetryError(new TypeError("network"))).toBe(true);
    expect(shouldRetryError(new Error("boom"))).toBe(false);
  });
});
