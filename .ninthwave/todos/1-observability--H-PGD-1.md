# Feat: PagerDuty task backend adapter (H-PGD-1)

**Priority:** High
**Source:** Vision L-VIS-6 — production signal pipeline
**Depends on:** None
**Domain:** observability

Implement `PagerDutyBackend` class in `core/backends/pagerduty.ts` following the same `TaskBackend + StatusSync` interface pattern as `GitHubIssuesBackend` and `ClickUpBackend`. The adapter connects PagerDuty incident streams to ninthwave's work queue.

**API integration:**
- Use PagerDuty REST API v2 (`https://api.pagerduty.com/`) via synchronous curl (same `syncFetch` pattern as ClickUp adapter)
- `list()`: GET `/incidents?statuses[]=triggered&statuses[]=acknowledged&service_ids[]={service_id}` — return active incidents as TodoItem[]
- `read(id)`: GET `/incidents/{incident_id}` — return a single incident as TodoItem
- `markDone(id)`: PUT `/incidents` with `[{"id": "{id}", "type": "incident_reference", "status": "resolved"}]` — resolve the incident

**Priority mapping:**
- PagerDuty `urgency: "high"` + `priority.name` containing "P1"/"SEV1" → critical
- PagerDuty `urgency: "high"` → high
- PagerDuty `urgency: "low"` → medium
- Suppressed incidents → low

**StatusSync implementation:**
- `addStatusLabel(id, label)`: Add a note to the incident via POST `/incidents/{id}/notes` with the label as note content
- `removeStatusLabel(id, label)`: No-op (PagerDuty notes are append-only — return true for idempotency)

**Configuration (convention over configuration):**
- `PAGERDUTY_API_TOKEN` env var (required — API v2 token)
- `PAGERDUTY_SERVICE_ID` env var or `pagerduty_service_id` config key (filter incidents to a specific service)
- `PAGERDUTY_FROM_EMAIL` env var or `pagerduty_from_email` config key (required for write operations)
- Add `resolvePagerDutyConfig()` function following `resolveClickUpConfig()` pattern

**TodoItem mapping:**
- `id`: `PGD-{incident_number}`
- `title`: Incident title
- `domain`: Service name (from incident's service reference)
- `rawText`: Incident description + first alert body, formatted as markdown
- `filePaths`: Extract file paths from alert details if present (custom_details may contain stack traces)

**Design constraints:**
- Injectable `HttpFetcher` for testing (same pattern as ClickUp)
- All network calls synchronous via `Bun.spawnSync` + curl
- Graceful degradation: return empty arrays on API errors, never throw
- PagerDuty API requires `Authorization: Token token={api_token}` header format

Acceptance: `PagerDutyBackend` implements `TaskBackend` and `StatusSync`. Config resolves from env vars and `.ninthwave/config`. Tests cover list, read, markDone, status labels, priority mapping, and error handling. All existing tests pass.

**Test plan:**
- Unit tests in `test/pagerduty.test.ts` with injected HTTP fetcher (no real API calls)
- Test `incidentToTodoItem()` with various urgency/priority combos → correct priority mapping
- Test `list()` returns TodoItem[] from mocked API response
- Test `read()` returns single TodoItem or undefined for missing incidents
- Test `markDone()` sends correct PUT request with proper from header
- Test `addStatusLabel()` creates incident note
- Test `removeStatusLabel()` is a no-op that returns true
- Test `resolvePagerDutyConfig()` with env vars present/missing
- Test graceful degradation on API errors (non-200 status, malformed JSON, auth failure)
- Edge case: incident with no description (empty rawText)
- Edge case: incident with multiple alerts (use first alert body)

Key files: `core/backends/pagerduty.ts`, `test/pagerduty.test.ts`, `core/types.ts`
