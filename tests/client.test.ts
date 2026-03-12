import { afterEach, describe, expect, test, vi } from "vitest";

import { NotFoundError, PaliClient } from "../src";

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

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {})
    }
  });
}

describe("PaliClient", () => {
  afterEach(() => {
    delete process.env.PALI_BASE_URL;
    delete process.env.PALI_TOKEN;
    delete process.env.PALI_TIMEOUT;
    vi.restoreAllMocks();
  });

  test("uses env fallback", async () => {
    process.env.PALI_BASE_URL = "http://example.com";
    process.env.PALI_TOKEN = "env-token";
    const { fetchFn, mock } = fetchMock(jsonResponse({ status: "ok", time: "2026-03-08T00:00:00Z" }));
    const client = new PaliClient(undefined, { fetchFn });

    const res = await client.health();

    expect(res.status).toBe("ok");
    const calls = mock.mock.calls;
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain("/health");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer env-token");
  });

  test("tenantStats is wired", async () => {
    const { fetchFn, mock } = fetchMock(jsonResponse({ tenant_id: "tenant_1", memory_count: 7 }));
    const client = new PaliClient("http://example.com", { fetchFn });

    const stats = await client.tenantStats("tenant_1");

    expect(stats.memoryCount).toBe(7);
    const calls = mock.mock.calls;
    const [url] = calls[0] as [string];
    expect(url).toContain("/v1/tenants/tenant_1/stats");
  });

  test("search retries on 503", async () => {
    const { fetchFn, mock } = fetchMock(
      jsonResponse({ error: "busy" }, 503),
      jsonResponse({ items: [] })
    );
    const client = new PaliClient("http://example.com", { fetchFn });

    const result = await client.search("tenant_1", "tea");

    expect(result.items).toEqual([]);
    expect(mock.mock.calls.length).toBe(2);
  });

  test("search sends retrieval_kind when provided", async () => {
    const { fetchFn, mock } = fetchMock(jsonResponse({ items: [] }));
    const client = new PaliClient("http://example.com", { fetchFn });

    await client.search("tenant_1", "tea", { retrievalKind: "entity" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.retrieval_kind).toBe("entity");
  });

  test("ingest endpoints are wired", async () => {
    const { fetchFn, mock } = fetchMock(
      jsonResponse({
        ingest_id: "ing_1",
        memory_ids: ["mem_1"],
        job_ids: ["ppj_1"],
        accepted_at: "2026-03-08T00:00:00Z"
      }, 202),
      jsonResponse({
        ingest_id: "ing_2",
        memory_ids: ["mem_2", "mem_3"],
        job_ids: ["ppj_2", "ppj_3"],
        accepted_at: "2026-03-08T00:00:01Z"
      }, 202)
    );
    const client = new PaliClient("http://example.com", { fetchFn });

    const single = await client.ingest("tenant_1", "likes tea");
    const batch = await client.ingestBatch([
      { tenantId: "tenant_1", content: "likes coffee" },
      { tenantId: "tenant_1", content: "likes hiking" }
    ]);

    expect(single.ingestId).toBe("ing_1");
    expect(batch.memoryIds.length).toBe(2);

    const [firstURL] = mock.mock.calls[0] as [string];
    const [secondURL] = mock.mock.calls[1] as [string];
    expect(firstURL).toContain("/v1/memory/ingest");
    expect(secondURL).toContain("/v1/memory/ingest/batch");
  });

  test("job endpoints are wired", async () => {
    const { fetchFn, mock } = fetchMock(
      jsonResponse({
        items: [
          {
            id: "ppj_1",
            ingest_id: "ing_1",
            tenant_id: "tenant_1",
            memory_id: "mem_1",
            type: "vector_upsert",
            status: "queued",
            attempts: 0,
            max_attempts: 5,
            available_at: "2026-03-08T00:00:00Z",
            lease_owner: "",
            leased_until: "0001-01-01T00:00:00Z",
            last_error: "",
            created_at: "2026-03-08T00:00:00Z",
            updated_at: "2026-03-08T00:00:00Z"
          }
        ]
      }),
      jsonResponse({
        id: "ppj_1",
        ingest_id: "ing_1",
        tenant_id: "tenant_1",
        memory_id: "mem_1",
        type: "vector_upsert",
        status: "queued",
        attempts: 0,
        max_attempts: 5,
        available_at: "2026-03-08T00:00:00Z",
        lease_owner: "",
        leased_until: "0001-01-01T00:00:00Z",
        last_error: "",
        created_at: "2026-03-08T00:00:00Z",
        updated_at: "2026-03-08T00:00:00Z"
      })
    );
    const client = new PaliClient("http://example.com", { fetchFn });

    const jobs = await client.listPostprocessJobs({
      tenantId: "tenant_1",
      statuses: ["queued", "running"],
      types: ["vector_upsert"],
      limit: 20
    });
    const job = await client.getPostprocessJob("ppj_1");

    expect(jobs.items.length).toBe(1);
    expect(job.id).toBe("ppj_1");

    const [listURL] = mock.mock.calls[0] as [string];
    const [getURL] = mock.mock.calls[1] as [string];
    expect(listURL).toContain("/v1/memory/jobs");
    expect(listURL).toContain("tenant_id=tenant_1");
    expect(listURL).toContain("status=queued%2Crunning");
    expect(getURL).toContain("/v1/memory/jobs/ppj_1");
  });

  test("store does not retry on 503", async () => {
    const { fetchFn, mock } = fetchMock(jsonResponse({ error: "busy" }, 503));
    const client = new PaliClient("http://example.com", { fetchFn });

    await expect(client.store("tenant_1", "tea")).rejects.toThrow("503");
    expect(mock.mock.calls.length).toBe(1);
  });

  test("maps 404 to NotFoundError", async () => {
    const { fetchFn } = fetchMock(
      jsonResponse(
        { error: "not found", code: "not_found" },
        404,
        { "X-Request-ID": "req_1" }
      )
    );
    const client = new PaliClient("http://example.com", { fetchFn });

    await expect(client.deleteMemory("tenant_1", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});
