# Feat: Render status on daemon stdout in TUI mode (H-TUI-1)

**Priority:** High
**Source:** Daemon output pivot plan — make the daemon the user-facing interface
**Depends on:**
**Domain:** daemon

## Context

The daemon currently outputs JSON log lines to stdout and relies on a separate `ninthwave status --watch` pane for visual status. This splits the UI across two surfaces. The pivot: the daemon's own stdout should render live status when connected to a TTY.

Extract the status rendering logic from `core/commands/status.ts` into a shared module (`core/status-render.ts`) so both `ninthwave status --watch` and the daemon TUI can use it. Then integrate TUI rendering into the orchestrate loop.

## Requirements

1. Extract the rendering functions from `core/commands/status.ts` (table rendering, ANSI color, cursor control) into a new `core/status-render.ts` module. The existing `status --watch` command should import from this shared module.
2. Add a `--json` flag to `ninthwave orchestrate`. When stdout is a TTY and `--json` is NOT set, enable TUI mode.
3. In TUI mode, render the status table to stdout after each poll cycle using the `onPollComplete` callback (the `items: OrchestratorItem[]` data is already available there).
4. In TUI mode, redirect structured JSON logs to the log file (`~/.ninthwave/projects/<slug>/orchestrator.log`) instead of stdout, using the same file descriptor approach as daemon child mode.
5. In JSON mode (or non-TTY), maintain current behavior: JSON lines to stdout.
6. Use ANSI cursor control (`\x1B[H` cursor home, `\x1B[K` clear line, `\x1B[J` clear to end) for flicker-free TUI updates, same approach as `status --watch`.

Acceptance: Running `ninthwave orchestrate --items X` in a terminal shows a live status table on stdout (no separate pane). Running with `--json` outputs JSON lines to stdout. Piped output (`| cat`) auto-detects non-TTY and uses JSON mode. The existing `ninthwave status --watch` command still works (uses shared rendering module). Structured logs go to the log file in TUI mode.

**Test plan:**
- Unit test: shared rendering module produces correct ANSI output for various item states
- Unit test: TUI mode detection (TTY + no --json → TUI, non-TTY → JSON, --json → JSON)
- Unit test: `onPollComplete` calls TUI render function when TUI mode is active
- Edge case: empty item list renders correctly
- Edge case: terminal resize mid-render doesn't crash

Key files: `core/commands/orchestrate.ts`, `core/commands/status.ts`, `core/status-render.ts` (new)
