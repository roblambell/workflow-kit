# Feat: Surface update notice in the status TUI footer (H-UPN-2)

**Priority:** High
**Source:** /decompose approved plan 2026-04-01 for passive TUI update notice
**Depends on:** H-UPN-1
**Domain:** update-notice
**Lineage:** 1c706e34-7b4c-44c7-9215-3025cc1a31ba

Thread the cached update state into the interactive TUI and render a short passive notice in the status footer only. Hydrate `tuiState.viewOptions` from cached state during orchestrate startup, kick off at most one background refresh when the cache is stale, and render the notice in `buildStatusLayout()` without showing it in logs-only mode. Preserve existing footer precedence so Ctrl-C exit confirmation and GitHub API warnings continue to win over the update notice.

**Test plan:**
- Extend `test/orchestrate.test.ts` to verify startup hydration from cached update state, one background refresh path, and disabled-config behavior
- Extend `test/status-render.test.ts` to verify footer notice rendering, GitHub warning precedence, Ctrl-C precedence, and narrow-width truncation behavior
- Manually verify the notice appears in status-only TUI mode and does not appear in logs-only mode

Acceptance: interactive orchestrate sessions can show a short `update available` footer notice from cached or freshly refreshed state, the notice is limited to the status TUI footer, and existing footer warnings/prompts keep their current precedence. `test/orchestrate.test.ts` and `test/status-render.test.ts` cover the new behavior and pass.

Key files: `core/commands/orchestrate.ts`, `core/status-render.ts`, `test/orchestrate.test.ts`, `test/status-render.test.ts`
