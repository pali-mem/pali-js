import { describe, expect, test, vi } from "vitest";

import { PaliClient, PaliMiddleware } from "../src";
import type { MemoryAction } from "../src/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function fetchMock(...responses: Response[]): { fetchFn: typeof fetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("missing mocked response");
    }
    return next;
  });
  return {
    fetchFn: mock as unknown as typeof fetch,
    mock
  };
}

describe("PaliMiddleware", () => {
  test("injects memory and stores turn", async () => {
    const { fetchFn, mock } = fetchMock(
      jsonResponse({
        items: [
          {
            id: "mem_1",
            tenant_id: "tenant_1",
            content: "User likes jazz.",
            tier: "semantic",
            tags: [],
            source: "seed",
            created_by: "system",
            kind: "observation",
            recall_count: 0,
            created_at: "2026-03-08T00:00:00Z",
            updated_at: "2026-03-08T00:00:00Z",
            last_accessed_at: "2026-03-08T00:00:00Z",
            last_recalled_at: "2026-03-08T00:00:00Z"
          }
        ]
      }),
      jsonResponse({
        items: [
          { id: "mem_2", created_at: "2026-03-08T00:00:00Z" },
          { id: "mem_3", created_at: "2026-03-08T00:00:00Z" }
        ]
      }, 201)
    );
    const client = new PaliClient("http://example.com", { fetchFn });
    const middleware = new PaliMiddleware(client, "tenant_1");

    const seen: Array<Record<string, unknown>> = [];
    const llm = async (messages: Array<Record<string, unknown>>) => {
      seen.push(...messages);
      return { content: "You like jazz." };
    };

    const wrapped = middleware.wrap(llm);
    const result = await wrapped([{ role: "user", content: "What do I like?" }]);

    expect((result as { content: string }).content).toBe("You like jazz.");
    expect(seen[0].role).toBe("system");
    expect(String(seen[0].content)).toContain("User likes jazz.");
    expect(mock.mock.calls.length).toBe(2);
  });

  test("degrades when search fails", async () => {
    const { fetchFn } = fetchMock(
      jsonResponse({ error: "busy" }, 503),
      jsonResponse(
        {
          items: [
            { id: "mem_2", created_at: "2026-03-08T00:00:00Z" },
            { id: "mem_3", created_at: "2026-03-08T00:00:00Z" }
          ]
        },
        201
      )
    );
    const client = new PaliClient("http://example.com", { fetchFn, maxRetries: 1 });
    const middleware = new PaliMiddleware(client, "tenant_1");
    const llm = async (messages: Array<Record<string, unknown>>) => ({ content: String(messages.length) });

    const wrapped = middleware.wrap(llm);
    const result = await wrapped([{ role: "user", content: "hello" }]);

    expect((result as { content: string }).content).toBe("1");
  });

  test("replace action works with opt-in destructive mode", async () => {
    const { fetchFn, mock } = fetchMock(
      jsonResponse({
        items: [
          {
            id: "mem_1",
            tenant_id: "tenant_1",
            content: "User lives in Boston.",
            tier: "semantic",
            tags: [],
            source: "seed",
            created_by: "system",
            kind: "observation",
            recall_count: 0,
            created_at: "2026-03-08T00:00:00Z",
            updated_at: "2026-03-08T00:00:00Z",
            last_accessed_at: "2026-03-08T00:00:00Z",
            last_recalled_at: "2026-03-08T00:00:00Z"
          }
        ]
      }),
      new Response(null, { status: 204 }),
      jsonResponse({ id: "mem_2", created_at: "2026-03-08T00:00:00Z" }, 201)
    );

    const client = new PaliClient("http://example.com", { fetchFn });
    const planner = (): MemoryAction[] => [
      {
        kind: "replace",
        memoryId: "mem_1",
        request: {
          tenantId: "tenant_1",
          content: "User lives in Austin.",
          kind: "observation",
          createdBy: "system"
        }
      }
    ];
    const middleware = new PaliMiddleware(client, "tenant_1", {
      allowDestructiveActions: true,
      actionPlanner: planner
    });

    const wrapped = middleware.wrap(async (_messages: Array<Record<string, unknown>>) => ({ content: "Moved to Austin" }));
    await wrapped([{ role: "user", content: "I moved to Austin" }]);

    expect(mock.mock.calls.length).toBe(3);
    const secondUrl = mock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toContain("/v1/memory/mem_1");
  });
});
