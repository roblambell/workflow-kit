# Engineering Review: Core Orchestrator and State Machine

**Date:** 2026-03-24
**Scope:** `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/shell.ts`, `core/git.ts`, `core/lock.ts`
**Tests:** `test/orchestrator.test.ts`, `test/orchestrate.test.ts`
**Reviewer:** Automated engineering review (H-ENG-1)

---

## Architecture Overview

The orchestrator follows a clean separation:

- **State machine** (`core/orchestrator.ts`): Pure `processTransitions()` takes a snapshot and returns actions. No side effects. `executeAction()` bridges to external deps via injection.
- **Command driver** (`core/commands/orchestrate.ts`): Event loop (poll → transition → execute → sleep), state reconstruction for crash recovery, snapshot building from GitHub/cmux, structured logging, daemon mode.
- **Supporting modules**: `shell.ts` (process spawning), `git.ts` (git operations), `lock.ts` (mkdir-based file lock).

The dependency injection pattern is well-applied throughout — `OrchestratorDeps`, `OrchestrateLoopDeps`, and injectable function parameters make the system testable without `vi.mock`.

---

## State Machine Analysis

### States (13 total)

| State | Terminal? | WIP? | Description |
|-------|-----------|------|-------------|
| `queued` | No | No | Waiting for dependencies |
| `ready` | No | No | Deps met, waiting for WIP slot |
| `launching` | No | Yes | Worker being launched |
| `implementing` | No | Yes | Worker active, no PR yet |
| `pr-open` | No | Yes | PR created, no CI status |
| `ci-pending` | No | Yes | CI running |
| `ci-passed` | No | Yes | CI passed |
| `ci-failed` | No | Yes | CI failed |
| `review-pending` | No | Yes | Waiting for review approval |
| `merging` | No | Yes | Merge initiated |
| `merged` | No | No | PR merged, pending cleanup |
| `done` | Yes | No | Successful completion |
| `stuck` | Yes | No | Failed, needs attention |

### Transition Map

```
queued ──[deps met]──→ ready ──[WIP slot]──→ launching
                                                │
                                    ┌───────────┤
                                    │           │
                              worker alive  worker dead
                                    │           │
                                    ▼           ▼
                              implementing    stuck
                                    │
                          ┌─────────┤
                          │         │
                      PR appears  worker dies
                          │         │
                          ▼         ▼
                       pr-open    stuck
                          │
              ┌───────────┼───────────┐
              │           │           │
          CI pending  CI passes   CI fails
              │           │           │
              ▼           ▼           ▼
          ci-pending  ci-passed   ci-failed ──[max retries]──→ stuck
              │           │           │
              │           │     ┌─────┤
              │           │     │     │
              │           │  CI pass  CI pending
              │           │     │     │
              │           │     ▼     ▼
              │           │ ci-passed ci-pending
              │           │
              │     ┌─────┼──────────────┐
              │     │     │              │
              │   asap  approved/ask   ext merge
              │     │     │              │
              │     ▼     ▼              ▼
              │  merging review-pending merged
              │     │     │              │
              │     │  [approved]        │
              │     │     │              │
              │     ▼     ▼              │
              │   merged ─┘              │
              │     │                    │
              │     ▼                    │
              └──→ done ◄────────────────┘
```

All states have documented exit transitions. External merge (`prState: "merged"`) is checked as priority exit from `pr-open`, `ci-pending`, `ci-passed`, `ci-failed`, `review-pending`, and `merging` states.

---

## Findings

### Category 1: State Transition Correctness

#### F1. Single-cycle multi-step chaining is untested (Medium)

**Observation:** When `handleImplementing` detects a PR, it falls through to `handlePrLifecycle` to process CI status in the same cycle. An item can chain through implementing → pr-open → ci-passed → merging in one `processTransitions` call. This optimization is correct but has no dedicated test.

**Risk:** A change to `handlePrLifecycle` could break the chaining path silently.

**Recommendation:** Add a test that provides a snapshot with both `prNumber`/`prState` and `ciStatus: "pass"` for an implementing item, and verify it reaches `merging` in one call.

**TODO:** H-TST-1

---

#### F2. `ciFailCount` persists across recovery cycles (Low, Observation)

**Observation:** When CI recovers (ci-failed → ci-passed), `ciFailCount` is not reset. This means an item has a lifetime budget of `maxCiRetries + 1` total CI failures. If CI fails once early, recovers, then fails again later, the second failure starts from count 1 not 0.

**Risk:** Low — this is conservative behavior. An item that repeatedly fails CI should be flagged.

**Recommendation:** Document this as intentional in the `maxCiRetries` config description. Consider a `ciFailCount` reset on successful merge evaluation as a future enhancement if users report confusion.

---

#### F3. `asap` merge strategy ignores `CHANGES_REQUESTED` review decision (Medium)

**Observation:** With `mergeStrategy: "asap"`, `evaluateMerge` triggers a merge when CI passes regardless of review state. A PR with explicit "changes requested" review decision would still be auto-merged. The `approved` and `ask` strategies correctly gate on review.

**Risk:** In repositories with required review workflows, this is harmless (GitHub blocks the merge). But in repos without branch protection, a PR with requested changes could be merged prematurely.

**Recommendation:** Add a guard in `evaluateMerge` for the `asap` strategy: if `reviewDecision === "CHANGES_REQUESTED"`, transition to `review-pending` instead of merging. This respects explicit human feedback even in the fastest merge mode.

**TODO:** H-ORC-2

---

#### F4. `pr-open` state is ephemeral due to fall-through (Low, Observation)

**Observation:** When `handleImplementing` detects a PR, it transitions to `pr-open` then immediately calls `handlePrLifecycle`, which typically advances to `ci-pending` or `ci-passed`. Items rarely remain in `pr-open` for a full poll cycle. The state exists for snapshot correctness (PR detected, no CI yet) but is effectively transitional.

**Risk:** None — this is correct behavior. The state serves as a logical step in the machine.

---

### Category 2: Error Handling

#### F5. `shell.ts` `run()` has no timeout support (High)

**Observation:** `Bun.spawnSync` in `run()` can block indefinitely. Git commands that prompt for SSH credentials, encounter network timeouts, or deadlock on large repos will hang the orchestrator's event loop. Since the event loop is single-threaded synchronous execution, a single hung command blocks all processing.

**Risk:** A slow git fetch or gh API call could halt the entire orchestrator. The poll→transition→execute cycle would stop, and all workers would appear stalled.

**Recommendation:** Add an optional `timeout` parameter to `run()` (default: 30s for git operations, 60s for gh API calls). Use Bun's `timeout` option in `spawnSync`. Return a timeout-specific error that callers can handle.

**TODO:** H-SHL-1

---

#### F6. Lock `acquireLock` has a TOCTOU race condition (High)

**Observation:** In `acquireLock`, the stale lock recovery sequence is:
1. `isLockStale(lockPath)` — returns true (process dead)
2. `removeLockDir(lockPath)` — removes stale lock
3. `tryMkdir(lockPath)` — tries to acquire

If two processes both detect staleness in the same window:
- Process A: detects stale → removes lock → creates lock → writes PID
- Process B: detects stale → removes A's lock → creates lock → writes PID
- Both processes believe they hold the lock

While `mkdir` is atomic on POSIX, the issue is that `removeLockDir` in step 2 by process B deletes process A's already-acquired lock (PID file and directory). Process A has already returned from `acquireLock` thinking it holds the lock.

**Risk:** In production, the orchestrator is the only process using this lock, so concurrent acquisition is unlikely. But the lock module is a general-purpose utility that could be reused. The race window is narrow but real.

**Recommendation:** Replace the stale-lock recovery with an atomic compare-and-swap: rename the PID file instead of deleting and recreating the directory. Or use `flock(2)` via Bun's FFI for a kernel-level lock. For now, at minimum: after writing the PID file, re-read it and verify the PID matches `process.pid` before returning (detect stolen locks).

**TODO:** H-LCK-1

---

#### F7. `executeClean` always returns `{ success: true }` (Low)

**Observation:** `executeClean` calls `deps.closeWorkspace()` and `deps.cleanSingleWorktree()` but ignores their return values. A clean failure (e.g., worktree locked, workspace already closed) is reported as success.

**Risk:** Low — cleanup is best-effort and non-blocking. The final worktree cleanup sweep in the event loop catches stragglers. However, the always-true result could mask systematic cleanup issues during debugging.

**Recommendation:** Return `success: false` if both operations fail. Log a warning if cleanup partially fails.

**TODO:** L-CLN-1

---

#### F8. `executeMerge` post-merge main pull has no retry mechanism (Low, Observation)

**Observation:** After a successful merge, `executeMerge` fetches and fast-forwards main. If this fails (network error, conflict), it's caught and swallowed with a comment "main will be pulled on next cycle." However, the main pull only happens during merge execution — there's no per-cycle main refresh.

**Risk:** Low — the local main staleness only matters for worktree creation (which uses HEAD) and is inconsequential for polling (which queries GitHub directly via `gh`). The next merge cycle will retry the pull.

---

### Category 3: Race Conditions in Concurrent Operations

#### F9. Concurrent merge actions in the same cycle can waste a merge attempt (Low)

**Observation:** If two items both pass CI in the same poll cycle, `processTransitions` emits merge actions for both. The event loop executes them sequentially. If the first merge changes main and creates a conflict for the second PR:
1. First merge succeeds → updates main → detects second PR has conflicts → sends rebase message
2. Second merge attempts anyway → fails (conflicts) → reverts to ci-passed

The second merge attempt is wasted because the conflict was already detected in step 1.

**Risk:** Low — the state machine self-corrects. The wasted `gh pr merge` call costs ~1-2 seconds.

**Recommendation:** Consider checking mergeability before executing each merge action. This would require `executeMerge` to consult `checkPrMergeable` before calling `prMerge`. However, this adds complexity for a minor optimization. Documenting the behavior is sufficient.

---

#### F10. Snapshot is not point-in-time atomic (Low, Observation)

**Observation:** `buildSnapshot` queries GitHub for each item sequentially. The snapshot represents a series of moments, not a single moment. A PR could merge between the first and last item's check, creating an inconsistent snapshot.

**Risk:** Low — state converges on the next poll cycle. The worst case is an unnecessary action (e.g., attempting to merge an already-merged PR), which is handled gracefully.

---

### Category 4: Recovery Robustness

#### F11. `ciFailCount` resets to 0 on crash recovery (Medium)

**Observation:** `reconstructState` rebuilds items from disk/GitHub state but does not recover `ciFailCount`. After a restart, an item that had already exhausted its CI retries gets a fresh budget. The item could cycle through additional CI failures before being marked stuck again.

**Risk:** Medium — in the worst case, a persistently failing item gets `maxCiRetries` additional attempts per restart, wasting CI resources and time.

**Recommendation:** Either:
1. Persist `ciFailCount` in the daemon state file (already serialized via `serializeOrchestratorState`)
2. Reconstruct from GitHub: count the number of failed check suites on the PR
3. Accept the reset as a feature (fresh starts after crashes)

Option 1 is simplest and aligns with the existing daemon state persistence.

**TODO:** M-REC-1

---

#### F12. `reconstructState` recovers workspace refs but not from daemon state file (Low, Observation)

**Observation:** `reconstructState` recovers `workspaceRef` from live cmux workspaces by pattern-matching item IDs in the workspace listing. This works well for live sessions but requires the cmux session to still be running. For daemon mode, the workspace ref is serialized in the state file, but `reconstructState` doesn't read the state file — it rebuilds from scratch.

**Risk:** Low — if the daemon crashes and restarts, workspaces are still alive in cmux. Recovery from live workspaces is the correct approach. The state file is primarily for external consumers (status display).

---

### Category 5: Test Coverage Gaps

#### F13. `executeRebase` action handler has no unit tests (Medium)

**Observation:** The `executeRebase` method is tested indirectly (rebase actions are emitted and the state machine advances) but has no direct unit test. Untested paths:
- Successful rebase message send
- Failed send when `workspaceRef` is missing (returns error)
- Failed send when `sendMessage` returns false

**Risk:** Medium — rebase is a critical recovery mechanism. A bug in the handler would cause items to stay in ci-failed state instead of recovering.

**TODO:** M-TST-2

---

#### F14. `review-pending` state with `CHANGES_REQUESTED` is untested (Medium)

**Observation:** When `handleReviewPending` sees `CHANGES_REQUESTED` review decision, it returns no actions (waits). This implicit behavior has no test. Also untested: what happens when CI regresses while in `review-pending` (CI status changes from pass to fail).

**Risk:** Medium — review workflows are important for the `approved` merge strategy. Missing test coverage could allow regressions.

**TODO:** M-TST-3

---

#### F15. `lock.ts` has no tests for timeout/backoff behavior (Medium)

**Observation:** `acquireLock` has exponential backoff (10ms → 20ms → ... → 200ms cap) and a timeout (default 5s). These behaviors have zero test coverage. The lock module also has no tests for:
- Stale lock detection and recovery
- PID file contents
- `releaseLock` cleanup

**Risk:** Medium — the lock is used to prevent concurrent orchestrator instances. A bug in the lock could allow double-execution.

**TODO:** M-TST-4

---

#### F16. `shell.ts` has no tests (Low)

**Observation:** The `run()` function has zero test coverage. It's a thin wrapper around `Bun.spawnSync`, but edge cases are untested: missing binary, large stdout truncation, stderr handling, exit code propagation.

**Risk:** Low — the function is simple and well-used indirectly through other tests. Direct tests would catch Bun version regressions.

**TODO:** L-TST-5

---

#### F17. `git.ts` functions have no direct unit tests (Low)

**Observation:** All 17 git functions are tested only indirectly through integration tests. Each function follows the same pattern: call `run("git", [...])`, check exit code, parse output. The error handling paths (non-zero exit codes) are untested directly.

**Risk:** Low — the array-based argument passing in `Bun.spawnSync` prevents shell injection. But error message formatting and edge cases (empty stdout, trimming) could regress.

**TODO:** L-TST-6

---

#### F18. `buildSnapshot` "ready" status from `checkPr` is untested (Low)

**Observation:** When `checkPrStatus` returns status "ready" (CI pass + review approved), `buildSnapshot` sets `ciStatus: "pass"`, `reviewDecision: "APPROVED"`, and `isMergeable: true`. This compound mapping is untested.

**Risk:** Low — the mapping is simple and static. But since "ready" is the only status that sets `reviewDecision`, a regression would silently break the `approved` merge strategy.

**TODO:** L-TST-7

---

#### F19. No test for `checkPrMergeable` absent (optional dep) in `executeMerge` (Low)

**Observation:** The post-merge conflict detection loop in `executeMerge` is gated behind `if (deps.checkPrMergeable)`. When the dep is absent, the loop is skipped. There's no test explicitly verifying this no-op behavior.

**Risk:** Very low — the guard is straightforward.

---

### Category 6: Code Quality and Maintainability

#### F20. `orchestrateLoop` function is large (~360 lines) (Low)

**Observation:** The main event loop handles: supervisor ticks, analytics collection, analytics commit, webhook notifications, cost capture, daemon state persistence, worktree cleanup sweeps, and the core poll→transition→execute cycle. While well-structured with injected deps, the function does many things.

**Risk:** Low — the code is readable and each concern is clearly delimited by comments. But adding more features to the loop increases cognitive load.

**Recommendation:** Extract post-completion handling (analytics, commit, webhooks, cleanup) into a `handleRunComplete()` helper. Extract the per-action execution block (cost capture, logging, webhook) into a `handleActionExecution()` helper.

**TODO:** L-REF-1

---

## Summary

| Category | Findings | High | Medium | Low |
|----------|----------|------|--------|-----|
| State Transitions | 4 | 0 | 1 | 3 (obs) |
| Error Handling | 4 | 2 | 0 | 2 (1 obs) |
| Race Conditions | 2 | 0 | 0 | 2 (obs) |
| Recovery | 2 | 0 | 1 | 1 (obs) |
| Test Coverage | 7 | 0 | 3 | 4 |
| Code Quality | 1 | 0 | 0 | 1 |
| **Total** | **20** | **2** | **5** | **13** |

**Overall assessment:** The orchestrator is well-designed with a clean separation between the pure state machine and side-effecting execution. The dependency injection pattern is applied consistently, making the system testable. The two high-severity findings (shell timeout and lock TOCTOU) are real but have low probability of manifesting in normal operation. Test coverage is strong for the happy path but has gaps in error handling and edge cases.

### Actionable TODOs created:

| ID | Priority | Title | Category |
|----|----------|-------|----------|
| H-SHL-1 | High | Add timeout support to `shell.ts` `run()` | Error Handling |
| H-LCK-1 | High | Fix TOCTOU race in `lock.ts` `acquireLock` | Error Handling |
| H-ORC-2 | High | Guard asap merge strategy against CHANGES_REQUESTED | State Transitions |
| M-REC-1 | Medium | Persist ciFailCount across crash recovery | Recovery |
| M-TST-2 | Medium | Add unit tests for `executeRebase` action handler | Test Coverage |
| M-TST-3 | Medium | Add tests for review-pending with CHANGES_REQUESTED | Test Coverage |
| M-TST-4 | Medium | Add tests for `lock.ts` timeout and backoff behavior | Test Coverage |
| L-TST-5 | Low | Add basic tests for `shell.ts` | Test Coverage |
| L-TST-6 | Low | Add unit tests for `git.ts` error handling | Test Coverage |
| L-TST-7 | Low | Add test for buildSnapshot "ready" status mapping | Test Coverage |
| L-CLN-1 | Low | Return actual success/failure from `executeClean` | Error Handling |
| L-REF-1 | Low | Extract helpers from `orchestrateLoop` | Code Quality |
