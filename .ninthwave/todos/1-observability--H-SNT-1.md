# Feat: Sentry task backend adapter (H-SNT-1)

**Priority:** High
**Source:** Vision L-VIS-6 — production signal pipeline
**Depends on:** None
**Domain:** observability

Implement `SentryBackend` class in `core/backends/sentry.ts` following the same `TaskBackend + StatusSync` interface pattern as `GitHubIssuesBackend` and `ClickUpBackend`. The adapter connects Sentry's issue stream to ninthwave's work queue, enabling the production-error-to-fix pipeline.

**API integration:**
- Use Sentry Web API (`https://sentry.io/api/0/`) via synchronous curl (same `syncFetch` pattern as ClickUp adapter)
- `list()`: GET `/projects/{org}/{project}/issues/?query=is:unresolved` — return unresolved issues as TodoItem[]
- `read(id)`: GET `/issues/{issue_id}/` — return a single issue as TodoItem
- `markDone(id)`: PUT `/issues/{issue_id}/` with `{"status": "resolved"}` — resolve the issue

**Priority mapping:**
- Sentry `level: "fatal"` → critical
- Sentry `level: "error"` → high
- Sentry `level: "warning"` → medium
- Sentry `level: "info"` / `level: "debug"` → low

**StatusSync implementation:**
- `addStatusLabel(id, label)`: Add an `assignedTo` tag or custom tag via PUT `/issues/{issue_id}/`
- `removeStatusLabel(id, label)`: Remove the tag

**Configuration (convention over configuration):**
- `SENTRY_AUTH_TOKEN` env var (required — bearer token)
- `SENTRY_ORG` env var or `sentry_org` config key
- `SENTRY_PROJECT` env var or `sentry_project` config key
- Add `resolveSentryConfig()` function following `resolveClickUpConfig()` pattern

**TodoItem mapping:**
- `id`: `SNT-{issue_id}`
- `title`: Sentry issue title
- `domain`: Sentry project slug
- `rawText`: Issue metadata (culprit, first/last seen, count) formatted as markdown
- `filePaths`: Extract file paths from Sentry's stacktrace `filename` field if available

**Design constraints:**
- Injectable `HttpFetcher` for testing (same pattern as ClickUp)
- All network calls synchronous via `Bun.spawnSync` + curl
- Graceful degradation: return empty arrays on API errors, never throw

Acceptance: `SentryBackend` implements `TaskBackend` and `StatusSync`. Config resolves from env vars and `.ninthwave/config`. Tests cover list, read, markDone, status labels, priority mapping, and error handling. All existing tests pass.

**Test plan:**
- Unit tests in `test/sentry.test.ts` with injected HTTP fetcher (no real API calls)
- Test `issuesToTodoItem()` with all Sentry severity levels → correct priority mapping
- Test `list()` returns TodoItem[] from mocked API response
- Test `read()` returns single TodoItem or undefined for missing issues
- Test `markDone()` sends correct PUT request
- Test `addStatusLabel()` / `removeStatusLabel()` idempotency
- Test `resolveSentryConfig()` with env vars present/missing
- Test graceful degradation on API errors (non-200 status, malformed JSON)
- Edge case: issue with no stacktrace (empty filePaths)
- Edge case: issue with very long title (truncation)

Key files: `core/backends/sentry.ts`, `test/sentry.test.ts`, `core/types.ts`
