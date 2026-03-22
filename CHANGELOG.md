# Changelog

## 0.2.0 - 2026-03-22

- Added async ingest API support (`/v1/memory/ingest`, `/v1/memory/ingest/batch`) with typed inputs and receipts.
- Added post-process job APIs (`/v1/memory/jobs`, `/v1/memory/jobs/:id`) with typed job models.
- Expanded request/response parity with latest Pali API route coverage.
- Refreshed package metadata and release notes alignment for the Pali v0.2 release train.

## 0.1.0 - 2026-03-08

- Initial `pali-js` package.
- Added typed `PaliClient` with health, tenant, and memory endpoints.
- Added retry policy with exponential backoff and `Retry-After` support.
- Added typed API error hierarchy.
- Added `PaliMiddleware` with search/inject/call/store lifecycle.
- Added OpenAI and Anthropic wrappers and opt-in destructive action planner.
