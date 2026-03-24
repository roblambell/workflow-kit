# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Worker Reliability (eng-review-workers, 2026-03-24)



### Test: Add TmuxAdapter unit tests (M-WRK-8)

**Priority:** Medium
**Source:** Eng review — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`TmuxAdapter` has zero test coverage. All 7 methods (`isAvailable`, `launchWorkspace`, `splitPane`, `sendMessage`, `readScreen`, `listWorkspaces`, `closeWorkspace`) are untested. Use the injectable `ShellRunner` constructor parameter to test without requiring tmux to be installed. Mirror the structure of the `CmuxAdapter` delegation tests.

**Test plan:**
- Test all 7 TmuxAdapter methods via injected ShellRunner
- Test session name generation (`nw-N` pattern)
- Test `listWorkspaces` filtering to `nw-` prefix
- Test `sendMessage` two-step (send-keys -l + Enter)
- Test error handling when tmux commands fail

Acceptance: All 7 `TmuxAdapter` methods have unit tests. Tests use dependency injection (ShellRunner), no real tmux required. Tests verify session name patterns, filtering, and error handling. No regression.

Key files: `core/mux.ts`, `test/mux.test.ts`

---

### Test: Add TmuxAdapter unit tests (M-WRK-8)

**Priority:** Medium
**Source:** Eng review — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`TmuxAdapter` has zero test coverage. All 7 methods (`isAvailable`, `launchWorkspace`, `splitPane`, `sendMessage`, `readScreen`, `listWorkspaces`, `closeWorkspace`) are untested. Use the injectable `ShellRunner` constructor parameter to test without requiring tmux to be installed. Mirror the structure of the `CmuxAdapter` delegation tests.

**Test plan:**
- Test all 7 TmuxAdapter methods via injected ShellRunner
- Test session name generation (`nw-N` pattern)
- Test `listWorkspaces` filtering to `nw-` prefix
- Test `sendMessage` two-step (send-keys -l + Enter)
- Test error handling when tmux commands fail

Acceptance: All 7 `TmuxAdapter` methods have unit tests. Tests use dependency injection (ShellRunner), no real tmux required. Tests verify session name patterns, filtering, and error handling. No regression.

Key files: `core/mux.ts`, `test/mux.test.ts`

---

## Orchestrator Review Findings (eng-review H-ENG-1, 2026-03-24)




### Fix: TOCTOU race in lock.ts acquireLock (H-LCK-1)

**Priority:** High
**Source:** Eng review H-ENG-1 — finding F6
**Depends on:** None

In `acquireLock`, two processes can both detect a stale lock and race to acquire it. Process A acquires the lock, then process B removes A's lock (thinking it's still stale) and acquires its own. Both believe they hold the lock. Fix by adding a verification step after PID file write: re-read the PID file and verify `process.pid` matches. If another process stole the lock, retry. This turns the TOCTOU into a detect-and-retry pattern with atomic verification.

**Test plan:**
- Unit test: acquireLock succeeds on first try when lock is free
- Unit test: acquireLock detects stale lock and recovers
- Unit test: acquireLock times out when lock is held by a live process
- Unit test: verify-after-write detects stolen lock and retries
- Edge case: PID file is deleted between write and verify (treat as stolen)

Acceptance: Lock acquisition is safe against concurrent stale-lock recovery. PID is verified after write. Existing timeout and backoff behavior preserved. Tests pass.

Key files: `core/lock.ts`, `test/lock.test.ts`

---

### Test: Add unit tests for executeRebase action handler (M-TST-2)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F13
**Depends on:** None

The `executeRebase` method in `core/orchestrator.ts` has no direct unit tests. It handles rebase message delivery to workers and is a critical recovery mechanism. Add tests covering: successful message send, failure when workspaceRef is missing, failure when `sendMessage` returns false.

**Test plan:**
- Unit test: executeRebase sends message to workspace and returns success
- Unit test: executeRebase returns error when workspaceRef is undefined
- Unit test: executeRebase returns error when sendMessage returns false
- Unit test: executeRebase uses action.message when provided, falls back to default

Acceptance: All four `executeRebase` paths are covered by unit tests. Tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Test: Add tests for lock.ts timeout and backoff behavior (M-TST-4)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F15
**Depends on:** None

`acquireLock` has exponential backoff (10ms → 200ms cap) and timeout (default 5s) with zero test coverage. Also untested: stale lock detection, PID file contents, and `releaseLock` cleanup. Add comprehensive tests for the lock module.

**Test plan:**
- Unit test: acquireLock succeeds immediately when lock is free
- Unit test: acquireLock throws after timeout when lock is held
- Unit test: acquireLock detects stale lock (dead PID) and recovers
- Unit test: releaseLock cleans up PID file and directory
- Unit test: isLockStale returns true for missing PID file
- Unit test: isLockStale returns true for dead process PID

Acceptance: Lock module has comprehensive test coverage including timeout, backoff, stale detection, and cleanup. Tests pass.

Key files: `core/lock.ts`, `test/lock.test.ts`

---

### Test: Add tests for lock.ts timeout and backoff behavior (M-TST-4)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F15
**Depends on:** None

`acquireLock` has exponential backoff (10ms → 200ms cap) and timeout (default 5s) with zero test coverage. Also untested: stale lock detection, PID file contents, and `releaseLock` cleanup. Add comprehensive tests for the lock module.

**Test plan:**
- Unit test: acquireLock succeeds immediately when lock is free
- Unit test: acquireLock throws after timeout when lock is held
- Unit test: acquireLock detects stale lock (dead PID) and recovers
- Unit test: releaseLock cleans up PID file and directory
- Unit test: isLockStale returns true for missing PID file
- Unit test: isLockStale returns true for dead process PID

Acceptance: Lock module has comprehensive test coverage including timeout, backoff, stale detection, and cleanup. Tests pass.

Key files: `core/lock.ts`, `test/lock.test.ts`

---

### Test: Add unit tests for git.ts error handling (L-TST-6)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F17
**Depends on:** None

All 17 git functions in `git.ts` are tested only indirectly. Add direct tests for error handling paths: non-zero exit codes throw with descriptive messages, helper functions return correct defaults on failure.

**Test plan:**
- Unit test: git helper throws Error with command name and stderr on failure
- Unit test: branchExists returns false on non-zero exit
- Unit test: commitCount returns 0 on failure
- Unit test: diffStat returns {0, 0} on failure
- Unit test: getStagedFiles returns [] on failure

Acceptance: Error handling paths in git.ts are directly tested. Tests pass.

Key files: `core/git.ts`, `test/git.test.ts`

---

### Test: Add test for buildSnapshot "ready" status mapping (L-TST-7)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F18
**Depends on:** None

When `checkPrStatus` returns "ready" (CI pass + review approved), `buildSnapshot` sets `ciStatus: "pass"`, `reviewDecision: "APPROVED"`, and `isMergeable: true`. This compound mapping is untested. Add a test.

**Test plan:**
- Unit test: buildSnapshot with checkPr returning "ready" status sets ciStatus pass, reviewDecision APPROVED, isMergeable true

Acceptance: The "ready" status mapping in buildSnapshot is tested. Tests pass.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

---

### Test: Add tests for extractTodoText and cross-repo cleanup paths (L-WRK-11)

**Priority:** Low
**Source:** Eng review — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`extractTodoText` in `core/commands/start.ts` has no tests (edge cases: missing ID, duplicate ID, malformed headers). The cross-repo worktree cleanup path in `cmdClean` (lines 199-214) is also untested. Add tests for both.

**Test plan:**
- Unit test: extractTodoText with valid ID returns correct text
- Unit test: extractTodoText with missing ID returns empty string
- Unit test: extractTodoText with duplicate IDs returns first match
- Unit test: cmdClean handles cross-repo worktrees from index file
- Unit test: cmdClean handles malformed cross-repo index entries

Acceptance: `extractTodoText` has unit tests covering edge cases. Cross-repo cleanup path in `cmdClean` has tests. All new tests pass. No regression.

Key files: `core/commands/start.ts`, `core/commands/clean.ts`, `test/start.test.ts`, `test/clean.test.ts`

---

## Detection Latency & Auto-Rebase (friction #17/#18, 2026-03-24)

### Feat: Surface detection latency in analytics summaries (L-DET-3)

**Priority:** Low
**Source:** Friction #17 — detection latency should feed into analytics
**Depends on:** M-DET-2

Include p50, p95, and max detection latency in per-run analytics summaries (`core/analytics.ts`). Flag runs where p95 detection latency exceeds a threshold (e.g., 60s) as having "slow detection" in the summary. This gives visibility into whether poll intervals are appropriate.

**Test plan:**
- Unit test: analytics summary includes latency percentiles
- Unit test: threshold flag is set when p95 exceeds limit
- Unit test: empty latency data (no transitions) produces clean output

Acceptance: Analytics run summaries include detection latency percentiles. Slow detection is flagged. Tests pass.

Key files: `core/analytics.ts`, `test/analytics.test.ts`

---

### Feat: Worker no-op PR path for TODOs that need no code change (M-DET-6)

**Priority:** Medium
**Source:** Grind cycle 2 observation — workers with no code changes have no clean exit path
**Depends on:** None

When a worker determines that a TODO requires no code change (already fixed, not applicable, or findings-only), the worker should create a "no-op" PR that only removes the TODO entry from TODOS.md. The PR body should explain why no code change was needed. This keeps the orchestrator's PR-based lifecycle working and provides an audit trail. Update the worker agent prompt (`agents/todo-worker.md`) to explicitly instruct workers that "no code change needed" is a valid outcome with a defined action: create a TODOS.md-only PR with an explanation.

**Test plan:**
- Verify worker agent prompt includes no-op PR instructions
- Manual test: worker processes a TODO that needs no code change and creates a TODOS.md-only PR
- Verify orchestrator correctly handles TODOS.md-only PRs through the merge lifecycle

Acceptance: Worker agent prompt includes explicit instructions for the no-op case. Workers create TODOS.md-only PRs when no code change is needed. PR body explains the rationale. Orchestrator handles these PRs normally. No regression.

Key files: `agents/todo-worker.md`, `core/orchestrator.ts`

---

### Refactor: Migrate friction log to per-stream directory (M-DET-7)

**Priority:** Medium
**Source:** Friction #19 — friction log consistency and conflict avoidance
**Depends on:** None

Replace the single `.ninthwave/friction.log` file with a `.ninthwave/friction/` directory using per-stream files. Each writer owns its own file: `worker-{ID}.yaml` for workers, `grind-cycle-{N}.md` for grind session observations, `supervisor-{date}.yaml` for supervisor anomalies. This eliminates merge conflicts on friction log files (each PR adds a new file, not appending to a shared file) and consolidates friction into the repo (the memory-system friction log becomes a pointer). Update: worker agent prompt, supervisor code, grind skill friction review phase to read from the directory, and add a commit step after friction review/decomposition.

**Test plan:**
- Verify workers write friction to `worker-{ID}.yaml` in the friction directory
- Verify grind friction review reads all files in the directory
- Verify no merge conflicts when multiple workers write friction simultaneously
- Verify old friction.log entries are migrated

Acceptance: `.ninthwave/friction/` directory exists. Workers, supervisor, and grind loop all write to their own files. Friction review reads the entire directory. The grind skill commits friction as part of its flow. Old single-file friction.log is migrated. No friction data is lost outside the repo. Tests pass.

Key files: `.ninthwave/friction.log`, `agents/todo-worker.md`, `core/supervisor.ts`, `.claude/skills/grind/SKILL.md`

---

## Workspace Lifecycle & Daemon Rebase (friction #23, 2026-03-24)

### Fix: Emit clean action when items transition to stuck (M-ORC-3)

**Priority:** Medium
**Source:** Friction #23 — orphaned workspaces after stuck items
**Depends on:** None

`stuckOrRetry()` returns `[]` when an item is permanently stuck — no clean action, so the workspace and worktree are never cleaned up. Same gap in the ci-failed → stuck path in `handlePrLifecycle`.

Return `[{ type: "clean", itemId: item.id }]` instead of `[]` in both stuck paths. `executeClean` already handles workspace closure + worktree cleanup correctly.

**Test plan:**
- Update existing stuck transition tests to expect a `"clean"` action
- Verify ci-failed → stuck (max retries exceeded) also emits clean action
- Verify heartbeat timeout → stuck emits clean action

Acceptance: All stuck transitions emit a clean action. Existing tests updated. `bun test test/` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Feat: Post-merge auto-rebase all sibling PRs via daemon (H-ORC-6)

**Priority:** High
**Source:** Friction #23 — CI churn from TODOS.md conflicts after merges
**Depends on:** H-ORC-5

After a PR merges, `executeMerge` checks sibling PRs for conflicts and sends rebase messages to workers. This causes CI churn — every worker rebases and triggers a new CI run. Replace the post-merge conflict detection loop with proactive daemon-rebase of ALL in-flight sibling PRs:

1. After pulling main, iterate all WIP sibling PRs with PR numbers
2. Try `deps.daemonRebase(worktreePath, branch)` for each
3. On success: continue (CI re-runs on force-pushed branch automatically)
4. On failure: check `checkPrMergeable` — if actually conflicting, send worker rebase message as fallback
5. If not conflicting: skip, no action needed

This eliminates TODOS.md-only conflicts before workers notice, reducing CI runs from N per conflict to 1.

**Test plan:**
- Update post-merge conflict detection tests for daemon-rebase-all behavior
- Test: daemon-rebase succeeds for sibling PRs (no worker message sent)
- Test: daemon-rebase fails, falls back to worker message for conflicting PRs
- Test: non-conflicting PRs skipped after daemon-rebase failure

Acceptance: After each merge, all sibling PRs are daemon-rebased. Worker rebase messages only sent as fallback. `bun test test/` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Fix: Reconcile closes orphaned workspaces (L-ORC-7)

**Priority:** Low
**Source:** Friction #23 — belt-and-suspenders cleanup
**Depends on:** M-ORC-3, M-ORC-4

`reconcile` only closes workspaces for merged items. Add `closeOrphanedWorkspaces(worktreeDir, mux)` to `clean.ts` — lists all TODO workspaces, closes any whose worktree directory no longer exists. A workspace with a live worktree is assumed in-flight and left alone. Call from reconcile after existing workspace cleanup.

**Test plan:**
- Test: workspace closed when worktree directory is missing
- Test: workspace left open when worktree directory exists
- Test: non-TODO workspaces are ignored

Acceptance: `ninthwave reconcile` cleans orphaned workspaces. In-flight workspaces preserved. `bun test test/` passes.

Key files: `core/commands/reconcile.ts`, `core/commands/clean.ts`, `test/reconcile.test.ts`, `test/clean.test.ts`

---

## Vision (recurring, 2026-03-24)




### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-5)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** ANL-*, WIP-*, GHI-*, DAE-*, RET-*, ENG-*, DP-*, DET-*, WRK-*, SHL-*, LCK-*, ORC-*, REC-*, TST-*, CLN-*, REF-*

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-6, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---
