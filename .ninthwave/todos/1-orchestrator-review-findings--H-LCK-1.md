# Fix: TOCTOU race in lock.ts acquireLock (H-LCK-1)

**Priority:** High
**Source:** Eng review H-ENG-1 — finding F6
**Depends on:** None
**Domain:** orchestrator-review-findings

In `acquireLock`, two processes can both detect a stale lock and race to acquire it. Process A acquires the lock, then process B removes A's lock (thinking it's still stale) and acquires its own. Both believe they hold the lock. Fix by adding a verification step after PID file write: re-read the PID file and verify `process.pid` matches. If another process stole the lock, retry. This turns the TOCTOU into a detect-and-retry pattern with atomic verification.

**Test plan:**
- Unit test: acquireLock succeeds on first try when lock is free
- Unit test: acquireLock detects stale lock and recovers
- Unit test: acquireLock times out when lock is held by a live process
- Unit test: verify-after-write detects stolen lock and retries
- Edge case: PID file is deleted between write and verify (treat as stolen)

Acceptance: Lock acquisition is safe against concurrent stale-lock recovery. PID is verified after write. Existing timeout and backoff behavior preserved. Tests pass.

Key files: `core/lock.ts`, `test/lock.test.ts`
