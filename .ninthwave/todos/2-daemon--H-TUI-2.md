# Feat: Add keyboard shortcuts and remove status pane (H-TUI-2)

**Priority:** High
**Source:** Daemon output pivot plan
**Depends on:** H-TUI-1
**Domain:** daemon

## Context

With H-TUI-1, the daemon renders status on its own stdout. The separate status pane (`ninthwave status --watch` in a cmux split) is now redundant and should be removed. The daemon's TUI also needs keyboard shortcuts for basic control.

## Requirements

1. In TUI mode, put `process.stdin` in raw mode to capture individual keystrokes.
2. Handle keyboard shortcuts:
   - `q` → graceful shutdown (trigger the existing SIGINT/AbortController flow)
   - `Ctrl-C` → graceful shutdown (same as `q`)
3. Disable raw mode in the `finally` cleanup block to restore terminal state.
4. Remove `launchStatusPane()` call from `cmdOrchestrate()` (currently at line ~2265).
5. Remove `closeStatusPane()` from the cleanup `finally` block (currently at line ~2317).
6. Stop writing `statusPaneRef` to `DaemonState` (keep the field in the interface for backward compat with existing state files, but always write `null`).
7. Remove the `closeStaleStatusPane()` function and its call.
8. Remove the `STATUS_PANE_NAME` constant if no longer referenced.
9. The standalone `ninthwave status --watch` command is unaffected — it still reads the state file independently.

Acceptance: The daemon no longer opens a separate status pane. Pressing `q` in the TUI triggers graceful shutdown. Terminal state is restored on exit (raw mode disabled). `ninthwave status --watch` still works as a standalone command. No `status_pane_opened` or `status_pane_closed` log events are emitted.

**Test plan:**
- Unit test: keyboard handler triggers abort on `q` keypress
- Unit test: keyboard handler triggers abort on Ctrl-C (0x03 byte)
- Unit test: `launchStatusPane` is no longer called in the orchestrate flow
- Unit test: `DaemonState.statusPaneRef` is always null in serialized state
- Edge case: non-TUI mode (JSON/piped) does not enable raw stdin

Key files: `core/commands/orchestrate.ts`, `core/daemon.ts`
