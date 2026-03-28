# Fix: Use process liveness as worker activity signal for timeout (H-WR-3)

**Priority:** High
**Source:** Friction: heartbeat-based-timeout.md (H-TUI-3 killed while active, 2026-03-28)
**Depends on:** None
**Domain:** worker-reliability

The orchestrator has a heartbeat mechanism (HEARTBEAT_TIMEOUT_MS: 5min) but workers may not emit heartbeats reliably. When heartbeat is stale, the fallback is commit-based timeout (launchTimeoutMs: 30min). A worker actively coding but not yet committing gets killed.

The orchestrator already checks `isWorkerAlive()` via CMux workspace listing (with 3-strike debounce for crash detection). This signal should also suppress timeout -- if the process is alive and running, the worker is likely still working.

Changes to `handleImplementing()` in `core/orchestrator.ts:793-861`:
1. After the heartbeat freshness check (lines 830-842), add a process liveness check: if `workerAlive` is true in the current snapshot, treat it as an activity signal that suppresses the launch timeout. The timeout becomes "no heartbeat AND no process activity for X minutes" rather than "no commits for 30 minutes."
2. Keep the activity timeout (60min since last commit) as a hard upper bound even when process is alive -- a process can be hung/spinning without producing useful work.
3. Log when timeout is suppressed by process liveness, so operators can see why a worker is running longer than expected.

The timeout hierarchy becomes:
- Fresh heartbeat (< 5 min) -> healthy, no timeout
- Process alive (workerAlive=true) -> activity signal, suppress launch timeout
- No heartbeat + process alive -> use activityTimeoutMs (60 min) as upper bound
- No heartbeat + process dead -> use launchTimeoutMs (30 min) or crash detection

**Test plan:**
- Test handleImplementing: worker with stale heartbeat but workerAlive=true is NOT marked stuck at launchTimeoutMs
- Test handleImplementing: worker with stale heartbeat and workerAlive=true IS marked stuck at activityTimeoutMs
- Test handleImplementing: worker with stale heartbeat and workerAlive=false is marked stuck at launchTimeoutMs (existing behavior)
- Test fresh heartbeat still takes priority over all other signals
- Test timeout suppression is logged as a structured event

Acceptance: Workers with active processes (workerAlive=true) are not killed at the 30-min launch timeout. Activity timeout (60 min) still applies as a hard cap. Timeout suppression is logged. `bun test test/` passes.

Key files: `core/orchestrator.ts:793-861,409`, `core/commands/orchestrate.ts:387-398`, `test/orchestrator-unit.test.ts:445-548`
