import { describe, expect, test } from "vitest";

import { PaliClient } from "../src";

const BASE_URL = process.env.PALI_TEST_BASE_URL;
const TOKEN = process.env.PALI_TEST_TOKEN ?? null;

const maybeTest = BASE_URL ? test : test.skip;

describe("live integration", () => {
  maybeTest("round trip against local/server instance", async () => {
    const suffix = Date.now().toString(36);
    const tenantId = `sdk-js-${suffix}`;
    const client = new PaliClient(BASE_URL, { token: TOKEN });

    await client.createTenant({ id: tenantId, name: "SDK JS Live Test" });
    const stored = await client.store(tenantId, "User likes tea", {
      kind: "observation",
      createdBy: "user"
    });
    const stats = await client.tenantStats(tenantId);
    const results = await client.search(tenantId, "tea", { topK: 3 });
    await client.deleteMemory(tenantId, stored.id);

    expect(stats.tenantId).toBe(tenantId);
    expect(results.items.some((m) => m.id === stored.id)).toBe(true);
  });
});
