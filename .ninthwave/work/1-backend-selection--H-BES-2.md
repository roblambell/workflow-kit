# Feat: Add backend choice to the startup flow (H-BES-2)

**Priority:** High
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** H-BES-1
**Domain:** backend-selection

Extend the startup settings journey so users can choose `Auto`, `tmux`, `cmux`, or `headless` before orchestration starts, and persist the confirmed choice for future runs. Preload the saved backend in the TUI, thread the selection through interactive startup results, and surface a non-blocking tip when an explicit mux choice cannot be honored and the run falls back to `headless`.

**Test plan:**
- Add widget coverage that the startup settings screen renders all four backend options and preselects the saved default.
- Verify `runInteractiveFlow()` and no-args startup return and persist the selected `backend_mode` on confirmation.
- Cover the fallback case where a saved or selected explicit backend is unavailable and the startup flow shows the headless tip instead of blocking.
- Verify existing startup defaults for merge, review, collaboration, and WIP still work unchanged when backend choice is added.

Acceptance: The startup settings screen includes backend selection with `Auto | tmux | cmux | headless`, confirmed launches persist `backend_mode`, and startup uses the fallback metadata from H-BES-1 to explain when `headless` is being used because a mux backend is unavailable.

Key files: `core/tui-widgets.ts`, `core/interactive.ts`, `core/commands/orchestrate.ts`, `core/commands/onboard.ts`, `test/tui-widgets.test.ts`, `test/interactive.test.ts`, `test/onboard.test.ts`, `test/orchestrate.test.ts`
