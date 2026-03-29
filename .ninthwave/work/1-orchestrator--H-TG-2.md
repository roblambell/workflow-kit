# Feat: Timeout grace period state machine (H-TG-2)

**Priority:** High
**Source:** Dogfood friction -- orchestrator kills timed-out workers immediately with no warning or chance to defer
**Depends on:** None
**Domain:** orchestrator

When a worker hits its timeout (activity: 60min, launch: 30min), the orchestrator calls `stuckOrRetry()` immediately. Add a grace period: on first timeout detection, set a deadline N minutes in the future and defer the kill. On subsequent ticks, only call `stuckOrRetry()` if the deadline has passed. Expose `extendTimeout(id)` so the TUI can push the deadline forward.

**New fields on `OrchestratorItem`:**
- `timeoutDeadline?: string` -- ISO timestamp after which timeout kill proceeds
- `timeoutExtensionCount?: number` -- number of user extensions

**New fields on `OrchestratorConfig`:**
- `gracePeriodMs: number` -- default 5 minutes (0 = immediate kill for JSON/daemon mode)
- `maxTimeoutExtensions: number` -- default 3

**New methods:**
- `private shouldDeferTimeout(item, now)` -- on first timeout detection, sets deadline and returns true. On subsequent calls, returns true if deadline is in the future.
- `public extendTimeout(id)` -- pushes deadline forward by `gracePeriodMs`, increments extension count, returns false if max extensions reached.

**Gate 4 timeout `stuckOrRetry` call sites** (not crash-detection sites):
- Line ~733: launch-timeout
- Line ~909: activity timeout (process alive)
- Line ~920: launch timeout (process dead)
- Line ~926: activity timeout (stale commits)

Each becomes: `if (this.shouldDeferTimeout(item, now)) return []; return this.stuckOrRetry(item, "...");`

**Clear grace period on state transitions** in `transition()` method: set `timeoutDeadline = undefined` and `timeoutExtensionCount = undefined`.

**Test plan:**
- Test: timeout detected -> grace period starts -> processTransitions returns [] (deferred)
- Test: grace period expires -> processTransitions returns stuckOrRetry actions
- Test: `extendTimeout()` pushes deadline, increments count
- Test: `extendTimeout()` returns false after maxTimeoutExtensions
- Test: worker recovery (new commit/heartbeat) clears grace state via transition()
- Test: `gracePeriodMs: 0` skips grace period entirely (immediate kill)
- Test: crash-detection sites (724, 863) are NOT gated by grace period

Acceptance: Workers get a 5-minute countdown before being killed on timeout. `extendTimeout()` adds 5 minutes per call up to 3 times. Grace period clears on recovery or state change. `gracePeriodMs: 0` preserves existing immediate-kill behavior. All existing timeout tests pass.

Key files: `core/orchestrator.ts:115`, `core/orchestrator.ts:383`, `core/orchestrator.ts:652`, `core/orchestrator.ts:733`, `core/orchestrator.ts:909`, `core/orchestrator.ts:939`, `test/orchestrator-unit.test.ts`
