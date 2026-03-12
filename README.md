# Pali JavaScript / TypeScript Client

Typed JS/TS SDK and middleware for the Pali memory API.

Pali is very early in development and should not be treated as a complete memory solution yet.
Right now the product focus is infrastructure correctness and reliability first.

Middleware is provided as an early-stage autopilot helper, not a guaranteed memory optimization system.

## Why JavaScript/TypeScript next

Recent ecosystem signals point to JS/TS as the best companion package to Python:

- Stack Overflow 2024 reports JavaScript as the most-used language in the survey and shows TypeScript adoption at 38.5% across respondents.
- GitHub's 2025 Octoverse update reports TypeScript as the #1 language by contributors on GitHub.
- npm describes itself as the world's largest software registry and registry for JavaScript packages.

## Install

```bash
npm install pali-client
```

## Quickstart

```ts
import { PaliClient } from "pali-client";

const client = new PaliClient("http://127.0.0.1:8080");
await client.createTenant({ id: "user:42", name: "User 42" });
await client.store("user:42", "Likes jazz", { kind: "observation", tags: ["music"] });
const results = await client.search("user:42", "music preferences", { topK: 3 });
console.log(results.items.map((m) => m.content));
```

## Environment variables

Low-priority constructor fallbacks:

- `PALI_BASE_URL`
- `PALI_TOKEN`
- `PALI_TIMEOUT` (milliseconds)

Constructor values always win over environment values.

## Middleware (Experimental Autopilot)

```ts
import { PaliClient, PaliMiddleware } from "pali-client";

const client = new PaliClient("http://127.0.0.1:8080");
const middleware = new PaliMiddleware(client, "user:42");

const llm = async (messages: Array<{ role: string; content: string }>) => {
  return { content: "You like jazz." };
};

const wrapped = middleware.wrap(llm);
await wrapped([{ role: "user", content: "What music do I like?" }]);
```

Destructive memory actions are opt-in:

```ts
import { PaliMiddleware } from "pali-client";

const middleware = new PaliMiddleware(client, "user:42", {
  allowDestructiveActions: true,
  actionPlanner: (_messages, recalled, _result, responseText) => {
    if (recalled.length && responseText.toLowerCase().includes("moved to austin")) {
      return [{
        kind: "replace",
        memoryId: recalled[0].id,
        request: {
          tenantId: "user:42",
          content: "User lives in Austin.",
          kind: "observation",
          createdBy: "system"
        }
      }];
    }
    return [];
  }
});
```

`replace` currently executes as delete-plus-store because the current Pali server has no `PATCH /v1/memory/:id` endpoint yet.

## API coverage

Implemented:

- `health()`
- `createTenant()`
- `tenantStats()`
- `store()`
- `storeBatch()`
- `ingest()`
- `ingestBatch()`
- `search()`
- `listPostprocessJobs()`
- `getPostprocessJob()`
- `deleteMemory()`

Not implemented because server endpoints are not currently exposed:

- `GET /v1/memory/:id`
- `PATCH /v1/memory/:id`
- `DELETE /v1/tenants/:id`
- cursor pagination and streaming memory feeds
