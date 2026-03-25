# Test: Add tests for lock.ts timeout and backoff behavior (M-TST-4)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F15
**Depends on:** None
**Domain:** orchestrator-review-findings

`acquireLock` has exponential backoff (10ms -> 200ms cap) and timeout (default 5s) with zero test coverage. Also untested: stale lock detection, PID file contents, and `releaseLock` cleanup. Add comprehensive tests for the lock module.

**Test plan:**
- Unit test: acquireLock succeeds immediately when lock is free
- Unit test: acquireLock throws after timeout when lock is held
- Unit test: acquireLock detects stale lock (dead PID) and recovers
- Unit test: releaseLock cleans up PID file and directory
- Unit test: isLockStale returns true for missing PID file
- Unit test: isLockStale returns true for dead process PID

Acceptance: Lock module has comprehensive test coverage including timeout, backoff, stale detection, and cleanup. Tests pass.

Key files: `core/lock.ts`, `test/lock.test.ts`
