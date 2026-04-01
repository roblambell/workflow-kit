# Fix: Render post-merge verifying and done in the status table (H-PS-1)

**Priority:** High
**Source:** Post-merge status plan 2026-04-01
**Depends on:** None
**Domain:** post-merge-status

Add explicit display states in the status table so merged work does not appear finished immediately. The table should show `Verifying` while default-branch post-merge checks are still being watched or a forward-fixer is running, and only show `Done` once post-merge verification has completed successfully.

Implementation notes:
- Extend the display-only `ItemState` in `core/status-render.ts` with `verifying` and `done`
- Update `mapDaemonItemState()` so `merged`, `forward-fix-pending`, and `fixing-forward` map to `verifying`, while `done` maps to `done`
- Keep `fix-forward-failed` rendered as a failure state
- Update blocker resolution and table grouping so only `done` is treated as completed on the display side
- Update queue/WIP counts so `verifying` still counts as active work
- Update detail rendering so `done` shows as complete without making `verifying` look terminal

**Test plan:**
- Update `test/status-render.test.ts` to cover the new `verifying` and `done` labels, icons, colors, and daemon-state mappings
- Add or update tests for blocker resolution, queue/WIP counts, and active/completed table grouping
- Refresh `test/golden/status-table.test.ts` so completed rows say `Done` and post-merge in-flight rows say `Verifying`
- Run `bun test test/status-render.test.ts test/golden/status-table.test.ts`

Acceptance: The status table and detail views show `Verifying` for post-merge work that is still being checked, show `Done` only after verification finishes, keep failed post-merge states visibly failed, and do not change execution semantics.

Key files: `core/status-render.ts`, `test/status-render.test.ts`, `test/golden/status-table.test.ts`
