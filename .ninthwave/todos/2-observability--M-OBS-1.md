# Feat: Wire observability backends into CLI list and start commands (M-OBS-1)

**Priority:** Medium
**Source:** Vision L-VIS-6 — production signal pipeline
**Depends on:** H-SNT-1, H-PGD-1
**Domain:** observability

Integrate the Sentry and PagerDuty backends into the CLI so users can list and process production signals through the standard ninthwave workflow.

**CLI changes:**

1. **`list` command** (`core/commands/list.ts`):
   - Add `--backend sentry` and `--backend pagerduty` flags
   - When `--backend` is specified, use the corresponding backend adapter instead of file-per-todo
   - When no `--backend` specified, auto-discover configured backends from env vars and show items from all sources (file-per-todo + any configured external backends)
   - Prefix output with backend source: `[sentry]`, `[pagerduty]`, `[clickup]`, `[github]`, `[local]`

2. **`init` command** (`core/commands/init.ts`):
   - During interactive onboarding, detect `SENTRY_AUTH_TOKEN` and `PAGERDUTY_API_TOKEN` env vars
   - If detected, ask whether to configure the observability backend
   - Write config keys (`sentry_org`, `sentry_project`, `pagerduty_service_id`) to `.ninthwave/config`

3. **Backend discovery** (`core/config.ts` or new `core/backend-registry.ts`):
   - Add a `discoverBackends()` function that checks env vars and config for all known backends
   - Returns an array of `{ name: string, backend: TaskBackend }` for each configured backend
   - Used by `list`, `start`, and `orchestrate` to merge items from multiple sources

**Design constraints:**
- Local file-per-todo is always included (it's the default)
- External backends are additive — they don't replace file-per-todo
- Items from external backends can be processed by the orchestrator the same way as local items
- Follow convention over configuration: if env vars are set, the backend is active

Acceptance: `nw list` shows items from all configured backends with source labels. `nw list --backend sentry` filters to Sentry items only. `nw init` detects and offers to configure Sentry/PagerDuty. Backend discovery works with zero config when env vars are present. All existing tests pass.

**Test plan:**
- Test `discoverBackends()` with various env var combinations (none, sentry only, pagerduty only, both)
- Test `list` command output includes source labels
- Test `list --backend sentry` filters correctly
- Test `init` command detects observability env vars
- Test that local file-per-todo items always appear regardless of `--backend` flag
- Edge case: backend configured but API unreachable (graceful degradation — show local items + warning)
- Run `bun test test/` to confirm no regressions

Key files: `core/commands/list.ts`, `core/commands/init.ts`, `core/config.ts`, `test/list.test.ts`, `test/init.test.ts`
