# Changelog

## 0.1.0 - 2026-03-08

- Initial `pali-js` package.
- Added typed `PaliClient` with health, tenant, and memory endpoints.
- Added retry policy with exponential backoff and `Retry-After` support.
- Added typed API error hierarchy.
- Added `PaliMiddleware` with search/inject/call/store lifecycle.
- Added OpenAI and Anthropic wrappers and opt-in destructive action planner.
