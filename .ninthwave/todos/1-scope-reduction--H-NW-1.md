# Refactor: Remove external task backends and StatusSync (H-NW-1)

**Priority:** High
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** None
**Domain:** scope-reduction

Remove all external task backend integrations (Sentry, PagerDuty, ClickUp, Linear, GitHub Issues), the backend registry, StatusSync interface, and the `--backend` flag from the list command. The `.ninthwave/todos/` file format remains as the canonical work item source.

**Delete files:**
- `core/backends/sentry.ts`, `core/backends/pagerduty.ts`, `core/backends/clickup.ts`, `core/backends/linear.ts`, `core/backends/github-issues.ts`
- `core/backend-registry.ts`
- `core/backends/` directory (empty after above)
- `test/sentry.test.ts`, `test/pagerduty.test.ts`, `test/clickup.test.ts`, `test/linear.test.ts`, `test/github-issues.test.ts`, `test/backend-registry.test.ts`, `test/status-sync.test.ts`

**Modify:**
- `core/types.ts` -- Remove `TaskBackend` interface (lines 82-89) and `StatusSync` interface (lines 92-100)
- `core/commands/list.ts` -- Remove all backend imports (lines 6-19), `--backend` flag parsing (lines 69-72), backend instantiation logic (lines 87-193)
- `core/commands/orchestrate.ts` -- Remove StatusSync import (line 37), `syncStatusLabels()` function (~line 800), invocation (~lines 1440-1446), `statusSync` from deps
- `core/commands/init.ts` -- Remove `detectObservabilityBackends()` (lines 228-237), config generation for backends (lines 310-323)
- `core/commands/doctor.ts` -- Remove any backend-specific health checks
- `core/cli.ts` -- Remove `usesExternalBackend` logic (lines 250-251), `--backend` from list command help (line 51)
- `core/config.ts` -- Remove keys: `CLICKUP_LIST_ID`, `sentry_org`, `sentry_project`, `pagerduty_service_id`, `pagerduty_from_email`, `linear_api_key`, `linear_team_key`
- `test/list.test.ts` -- Remove backend-related test cases
- `test/init.test.ts` -- Remove backend detection test cases

**Test plan:**
- Run `bun test test/` -- all surviving tests must pass
- Verify `grep -r "from.*backends/" core/` returns nothing (no dead imports)
- Verify `ninthwave list` still reads `.ninthwave/todos/` correctly without `--backend` flag

Acceptance: All backend files deleted, no references to backends remain in core/, `bun test test/` passes, `--backend` flag removed from CLI help.

Key files: `core/backends/`, `core/backend-registry.ts`, `core/commands/list.ts`, `core/commands/orchestrate.ts`, `core/types.ts`, `core/config.ts`
