# Fix: Thread session start time through to metrics display (H-TUI-2)

**Priority:** High
**Source:** TUI status display improvements
**Depends on:** None
**Domain:** tui-status

Session metrics (session duration, throughput) display as `-` because `sessionStartedAt` is never passed through to the metrics computation. The daemon captures `daemonStartedAt` at startup (orchestrate.ts line 1892) and stores it in `DaemonState.startedAt`, but neither `renderTuiFrame()` nor `renderStatus()` pass it to `formatStatusTable()`.

Thread `sessionStartedAt` through both rendering paths: (1) In the daemon TUI, pass `daemonStartedAt` via ViewOptions when calling `formatStatusTable()` from `renderTuiFrame()`. (2) In `renderStatus()` (status.ts), read `DaemonState.startedAt` from the state file and pass it as `sessionStartedAt` in ViewOptions.

**Test plan:**
- Unit test `computeSessionMetrics()` with a valid `sessionStartedAt` returns non-null `sessionDurationMs` and `throughputPerHour`
- Unit test `formatMetricsPanel()` renders actual values (not `-`) when metrics have data
- Integration: run `ninthwave status --watch` while daemon is active, verify session duration and throughput show real values

Acceptance: Session duration counts up from daemon start time. Throughput shows items/hr once at least one item has merged. Both `ninthwave status --watch` and the daemon TUI display these values correctly.

Key files: `core/status-render.ts:530-613`, `core/commands/status.ts:359-447`, `core/commands/orchestrate.ts:128-139`
