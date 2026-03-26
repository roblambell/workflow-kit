# Fix: Zellij session exits immediately when orchestrator launches (H-MUX-2)

**Priority:** High
**Source:** Dogfood friction — "Bye from Zellij!" on orchestrate launch
**Depends on:**
**Domain:** mux

## Context

Running `ninthwave orchestrate --mux zellij` inside an active zellij session causes the session to immediately exit with "Bye from Zellij!". The user loses their entire terminal session.

Root causes:
1. `isInsideWorkspace()` in orchestrate.ts only checks `CMUX_WORKSPACE_ID` and `TMUX`, not `ZELLIJ_SESSION_NAME`. When running inside zellij, it returns false.
2. Because `isInsideWorkspace()` returns false, `launchStatusPane()` calls `mux.launchWorkspace()` (creates a new tab) instead of `mux.splitPane()` (splits within current tab).
3. When cleanup or shutdown calls `closeWorkspace()` on that tab, `zellij action close-tab` can close the last tab, which exits the entire zellij session.
4. `ZellijAdapter.closeWorkspace()` has a fallback that calls `zellij delete-session` if the tab isn't found, which is destructive.

## Requirements

1. Add `ZELLIJ_SESSION_NAME` to `isInsideWorkspace()` check in orchestrate.ts
2. Add safeguard in `ZellijAdapter.closeWorkspace()`:
   - Before closing a tab, check if it's the last tab (or at minimum, never close the tab the orchestrator is running in)
   - Remove the `delete-session` fallback — closing a workspace should never delete the session
3. Add integration tests for zellij adapter behavior:
   - `isInsideWorkspace()` returns true when `ZELLIJ_SESSION_NAME` is set
   - `launchStatusPane()` calls `splitPane()` (not `launchWorkspace()`) when inside a zellij session
   - `closeWorkspace()` does not call `delete-session`
4. Verify the same patterns work correctly for tmux and cmux adapters

Acceptance: Running `ninthwave orchestrate --mux zellij` inside a zellij session does NOT exit the session. Status pane is created as a split pane within the current tab. Closing workspaces never deletes the session. Tests prove all three multiplexer adapters handle `isInsideWorkspace()` correctly.

**Test plan:** Unit test `isInsideWorkspace()` with each env var (`CMUX_WORKSPACE_ID`, `TMUX`, `ZELLIJ_SESSION_NAME`). Unit test `launchStatusPane()` calls `splitPane()` when inside workspace. Unit test `ZellijAdapter.closeWorkspace()` never calls `delete-session`. Integration test: mock zellij CLI commands and verify the full orchestrator startup sequence doesn't issue destructive commands.

Key files: `core/mux.ts`, `core/commands/orchestrate.ts`
