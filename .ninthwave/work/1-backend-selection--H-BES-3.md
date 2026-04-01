# Feat: Apply backend choice at runtime and surface headless mode clearly (H-BES-3)

**Priority:** High
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** H-BES-1
**Domain:** backend-selection

Use the resolved backend choice during actual worker launch so explicit `tmux` and `cmux` selections are honored even when the current session environment would normally pick a different adapter. Keep `headless` launches detached and observable, and improve runtime/status output so users can see when workers are running in headless mode and where to look for logs when needed.

**Test plan:**
- Add mux and launch coverage that explicit backend selections use the requested adapter instead of raw auto-detection.
- Verify `headless` launch paths still create detached workers with correct pid/log bookkeeping.
- Add status-render coverage so headless workers are labeled clearly in watch/status output.
- Verify `auto` preserves current interactive behavior when tmux or cmux is available.

Acceptance: Runtime launch code uses the backend resolver instead of ambient detection alone. Explicit `tmux` and `cmux` selections remain respected inside other session types. Headless launches still work end-to-end and are clearly identified in runtime/status messaging.

Key files: `core/mux.ts`, `core/commands/launch.ts`, `core/headless.ts`, `core/status-render.ts`, `core/cli.ts`, `test/launch.test.ts`, `test/headless.test.ts`, `test/mux.test.ts`, `test/status-render.test.ts`
