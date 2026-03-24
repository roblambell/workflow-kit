# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Orchestrator reliability (dogfood friction, 2026-03-24)

### Fix: Detect CI failures and notify workers to rebase (H-ORC-1)

**Priority:** High
**Source:** Dogfood friction #5, #6
**Depends on:** None

The orchestrator's `checkPrStatus` (watch.ts) correctly parses failing CI and the state machine has a `ci-pending → ci-failed` transition, but items observed in production stayed in `ci-pending` for 5+ minutes with failing CI. Investigate why the transition doesn't fire reliably — likely a race between snapshot polling and check status propagation. Also: when CI fails due to merge conflicts with main (friction #6), the orchestrator should auto-send a rebase message to the worker rather than requiring manual intervention.

**Test plan:**
- Add unit test: `checkPrStatus` returns `"failing"` when GitHub checks report failure
- Add integration test: state machine transitions `ci-pending → ci-failed` on snapshot with `ciStatus: "fail"`
- Test rebase notification: when ci-failed is caused by merge conflict, worker receives rebase message
- Edge case: CI that's still pending (no conclusion yet) should remain in `ci-pending`

Acceptance: Orchestrator transitions items to `ci-failed` within one poll cycle of CI reporting failure. When CI failure is caused by merge conflicts with main, orchestrator sends a rebase message to the worker. Items no longer get stuck in `ci-pending` with failing CI.

Key files: `core/commands/watch.ts:47-100`, `core/orchestrator.ts:343-376`, `core/commands/orchestrate.ts:134-158`

---

## Status command (dogfood friction, 2026-03-24)

### Fix: Status watch shows blank output when run standalone (H-STU-3)

**Priority:** High
**Source:** Dogfood friction #11
**Depends on:** None

`ninthwave status --watch` shows nothing when run manually outside the orchestrator context. `cmdStatus` (status.ts:405-470) scans `worktreeDir` for `todo-*` directories and reads TODOS.md for titles. When no worktrees exist it prints an empty table — but the user sees a completely blank screen (just ANSI clear codes). The command should show a meaningful "no active items" message, and should also verify the worktreeDir path is correct when invoked from the CLI dispatcher.

**Test plan:**
- Unit test: `cmdStatus` with empty worktreeDir shows "No active items" message
- Unit test: `cmdStatus` with non-existent worktreeDir shows informative message
- Test that terminal width detection handles undefined `process.stdout.columns`
- Edge case: worktreeDir exists but has no `todo-*` entries

Acceptance: `ninthwave status --watch` displays a meaningful message when no worktrees are active (not blank). Terminal width detection gracefully handles non-TTY contexts. The worktreeDir path is correctly resolved when invoked standalone via the CLI.

Key files: `core/commands/status.ts:377-470`, `core/cli.ts:214-215`

---

### Feat: Open status pane in current workspace instead of new workspace (M-MUX-1)

**Priority:** Medium
**Source:** Dogfood friction #12
**Depends on:** H-STU-3

`launchStatusPane` calls `mux.launchWorkspace()` which always creates a new workspace. VISION.md says "auto-pane in cmux." Add a `splitPane()` method to the Multiplexer interface that creates a pane in the current workspace. Use `CMUX_WORKSPACE_ID` or `TMUX` env vars to detect the current workspace context and split there. Fall back to `launchWorkspace()` if not running inside a workspace.

**Test plan:**
- Unit test: `splitPane` on CmuxAdapter calls appropriate cmux CLI command
- Unit test: `splitPane` on TmuxAdapter calls `tmux split-window`
- Test fallback: when not in a workspace context, `launchStatusPane` creates a new workspace
- Test detection: `CMUX_WORKSPACE_ID` env var triggers pane split behavior

Acceptance: When the orchestrator runs inside an existing workspace, the status pane opens as a split pane in that workspace (not a new workspace). When running outside a workspace, falls back to creating a new workspace. Multiplexer interface has a `splitPane()` method implemented for both adapters.

Key files: `core/mux.ts:15-28`, `core/cmux.ts:16-30`, `core/commands/orchestrate.ts:673-679`

---

## Vision (recurring, 2026-03-24)










### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-4)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** ORC-*, MUX-*, DF-*, WLD-*, INI-*, STU-*, WHK-*, TPL-*, ANL-*

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-5, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---
