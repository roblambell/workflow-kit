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

### Test: Add tests for review-pending with CHANGES_REQUESTED (M-TST-3)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F14
**Depends on:** None

The `handleReviewPending` handler has no test for `CHANGES_REQUESTED` review decision or CI regression while in review-pending. Add tests verifying: review-pending stays in review-pending when review is CHANGES_REQUESTED, review-pending behavior when CI regresses to fail.

**Test plan:**
- Unit test: review-pending with CHANGES_REQUESTED and CI pass → stays review-pending
- Unit test: review-pending with CHANGES_REQUESTED and CI fail → behavior documented
- Unit test: review-pending with external merge → transitions to merged

Acceptance: Review-pending edge cases are covered by unit tests. Tests pass.

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

### Test: Add basic tests for shell.ts (L-TST-5)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F16
**Depends on:** None

The `run()` function has zero test coverage. Add basic tests for: successful command execution, non-zero exit code handling, stderr capture, stdout trimming.

**Test plan:**
- Unit test: run() captures stdout from a simple command
- Unit test: run() captures stderr
- Unit test: run() returns correct exit code for failing command
- Unit test: run() trims whitespace from stdout and stderr

Acceptance: Basic `run()` behavior is covered by tests. Tests pass.

Key files: `core/shell.ts`, `test/shell.test.ts`

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

### Fix: Include TODO ID in tmux session names for workspace identification (L-WRK-10)

**Priority:** Low
**Source:** Eng review W-26 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`TmuxAdapter` uses session names like `nw-1`, `nw-2` which don't include the TODO ID. `closeWorkspacesForIds` and `isWorkerAlive` rely on the TODO ID appearing in workspace listings. Change tmux session names to include the TODO ID (e.g., `nw-H-WRK-1-1`) for reliable workspace identification.

**Test plan:**
- Unit test: tmux session name includes TODO ID when provided
- Unit test: closeWorkspacesForIds finds tmux sessions by TODO ID
- Unit test: isWorkerAlive correctly matches tmux sessions

Acceptance: Tmux session names include the TODO ID. Workspace identification functions reliably match tmux sessions. Tests verify ID-based matching. No regression.

Key files: `core/mux.ts`, `core/commands/orchestrate.ts`, `test/mux.test.ts`

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

### Refactor: Return actual success/failure from executeClean (L-CLN-1)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F7
**Depends on:** None

`executeClean` always returns `{ success: true }` regardless of whether `closeWorkspace` or `cleanSingleWorktree` actually succeeded. Return `success: false` with an error message if both operations fail, to aid debugging of systematic cleanup issues.

**Test plan:**
- Unit test: executeClean returns success when cleanup works
- Unit test: executeClean returns success when only one operation fails (partial cleanup is OK)
- Unit test: executeClean returns failure when both operations fail

Acceptance: `executeClean` returns accurate success/failure status. Partial cleanup (one of two operations succeeds) is still reported as success. Tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Refactor: Extract helpers from orchestrateLoop (L-REF-1)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F20
**Depends on:** None

The `orchestrateLoop` function handles ~360 lines of logic: supervisor ticks, analytics, webhooks, cost capture, daemon state persistence, cleanup sweeps, and the core loop. Extract post-completion handling into `handleRunComplete()` and per-action execution into `handleActionExecution()` to improve readability without changing behavior.

**Test plan:**
- Verify all existing orchestrateLoop tests still pass after refactoring
- No new tests needed — this is a pure refactoring with no behavior changes

Acceptance: `orchestrateLoop` is shorter and delegates to extracted helpers. All existing tests pass without modification. No behavior changes.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

---

## Detection Latency & Auto-Rebase (friction #17/#18, 2026-03-24)



### Feat: Add detection latency timestamps to state transitions (M-DET-2)

**Priority:** Medium
**Source:** Friction #17 — no measurement of detection latency
**Depends on:** None

Add `eventTime` and `detectedTime` fields to state transition records. `eventTime` is the timestamp from the external system (e.g., GitHub's `completedAt` for CI checks, `mergedAt` for merges, `updatedAt` for mergeable status changes). `detectedTime` is `Date.now()` when the orchestrator's poll cycle picks up the change. Store these in `OrchestratorItem` alongside `lastTransition`. Calculate `detectionLatencyMs = detectedTime - eventTime` and emit as a structured log event.

**Test plan:**
- Unit test: state transition records both eventTime and detectedTime
- Unit test: detectionLatencyMs is calculated correctly
- Unit test: missing eventTime (not available from API) falls back to detectedTime
- Verify latency appears in structured log output

Acceptance: State transitions include `eventTime`, `detectedTime`, and `detectionLatencyMs`. The orchestrator logs detection latency on every state change. Fields are optional/backward-compatible with existing state. Tests pass.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/commands/watch.ts`, `test/orchestrator.test.ts`

---

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

### Feat: Priority-ordered merge queue (M-DET-5)

**Priority:** Medium
**Source:** Friction #18 — parallel PRs should merge in priority order to minimize conflict cascades
**Depends on:** H-DET-1

When multiple PRs are in `ci-passed` state simultaneously, merge them in priority order (high → medium → low, then by item ID as tiebreaker) rather than racing. After each merge, trigger auto-rebase on remaining PRs before merging the next. This prevents the cascade where all PRs conflict with each other and need individual manual rebases.

**Test plan:**
- Unit test: multiple ci-passed items are merged in priority order
- Unit test: after each merge, remaining items are checked for conflicts
- Unit test: equal-priority items are merged by ID order
- Unit test: single ci-passed item skips queue logic

Acceptance: The orchestrator merges PRs sequentially in priority order when multiple are ready. Rebase checks happen between merges. Tests cover ordering and conflict detection. No regression.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `test/orchestrator.test.ts`

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

### Fix: Close workspaces for terminal items in final cleanup sweep and on shutdown (M-ORC-4)

**Priority:** Medium
**Source:** Friction #23 — orphaned workspaces survive orchestrator exit
**Depends on:** None

Two gaps in the orchestrate event loop:

1. **Final cleanup sweep**: Calls `cleanSingleWorktree` for terminal items but never closes their workspace first. Add `closeWorkspace(item.workspaceRef)` before worktree cleanup.
2. **Shutdown**: After the loop exits, close workspaces only for terminal items (done, stuck, merged). Do NOT close workspaces for in-flight items (implementing, ci-pending, etc.) — those workers may still be actively running and should survive orchestrator restarts. On restart, `reconstructState` recovers their workspace refs.

**Test plan:**
- Verify `closeWorkspace` called for terminal items in final sweep
- Verify in-flight item workspaces are NOT closed on shutdown
- Verify signal handler (SIGINT) triggers terminal-only cleanup

Acceptance: Terminal item workspaces are closed on orchestrator exit. In-flight workers survive restarts. `bun test test/` passes.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

---

### Fix: ci-pending conflict uses daemon-rebase instead of worker rebase (H-ORC-5)

**Priority:** High
**Source:** Friction #23 — unnecessary CI churn from worker rebases
**Depends on:** None

The ci-pending conflict detection (line ~504 in `handlePrLifecycle`) sends `type: "rebase"` (worker-side) for PRs with merge conflicts. Change to `type: "daemon-rebase"`. `executeDaemonRebase` already tries daemon resolution first (handles TODOS.md-only conflicts automatically), falling back to worker message if it fails.

One-line change: `type: "rebase"` → `type: "daemon-rebase"`.

**Test plan:**
- Update ci-pending conflict tests to expect `"daemon-rebase"` action type
- Verify rebaseRequested dedup flag still works with daemon-rebase
- Verify flag resets on state change

Acceptance: ci-pending PRs with merge conflicts get daemon-rebase instead of worker rebase. `bun test test/` passes.

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

## Distribution & CLI Identity (2026-03-24)


### Feat: Add `nw` short alias for the CLI binary (M-CLI-1)

**Priority:** Medium
**Source:** CEO review — CLI command naming decision
**Depends on:** None

Install both `ninthwave` and `nw` as CLI entry points. `nw` is the daily-driver short form (2 chars, no conflicts), `ninthwave` is the full name for docs and scripts. When distributing via Homebrew tap (`ninthwave-sh/tap`), the formula should install the primary binary as `ninthwave` with a symlink `nw` → `ninthwave`. For local development, the `setup` command should create the symlink.

Precedent: `uv` (2 chars), `fd` (2 chars), `rg` (2 chars) all ship as short binaries via Homebrew. `n` is taken (Node.js version manager). `nwave` was considered but doesn't add value when you have both `nw` and `ninthwave`.

**Test plan:**
- Verify `nw` symlink is created by setup command
- Verify `nw start`, `nw list`, `nw status` all work identically to `ninthwave` equivalents
- Verify Homebrew formula installs both names

Acceptance: Both `nw` and `ninthwave` invoke the CLI. Docs reference both (with `nw` as the recommended short form). Homebrew formula includes `bin.install_symlink`.

Key files: `core/cli.ts`, `core/commands/setup.ts`, `homebrew/ninthwave.rb` (new)

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
