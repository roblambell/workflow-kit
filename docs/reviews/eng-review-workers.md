> **Note:** This review was written before the file-per-todo migration. TODOS.md references are historical.

# Engineering Review: Worker Lifecycle and Communication

**Reviewed:** 2026-03-24
**Modules:** `core/commands/launch.ts`, `core/mux.ts`, `core/cmux.ts`, `core/send-message.ts`, `core/commands/clean.ts`, `core/commands/reconcile.ts`
**Related tests:** `test/launch.test.ts`, `test/mux.test.ts`, `test/clean.test.ts`, `test/reconcile.test.ts`, `test/cmux.test.ts`

---

## 1. Worker Launch (`core/commands/launch.ts`)

### 1.1 AI Tool Detection

`detectAiTool()` uses a 5-step detection chain: env override, OpenCode env, Claude env, process tree walk, then binary fallback.

**Finding W-1: Process tree walk is platform-fragile (Medium)**
The `ps -o comm= -p <pid>` walk (lines 58-72) relies on `ps` flags that differ across platforms. macOS `ps` uses BSD-style flags; Linux uses procfs. The `comm` field truncates long binary names (15 chars on Linux, varies on macOS). This works today because all supported tool names (`claude`, `opencode`, `copilot`) are short, but it's a latent portability risk.

Additionally, the walk has no guard against PID recycling — if a parent process dies and its PID is reused by an unrelated `claude` process during detection, we'd get a false positive. This is extremely unlikely in practice (10-step depth limit helps), but worth noting.

**Finding W-2: `detectAiTool` falls through to `which` check that may return wrong tool (Low)**
The final fallback (lines 74-77) checks `which claude`, `which opencode`, `which copilot` in order. If the user has `claude` on their PATH but is actually running from `opencode`, the fallback will incorrectly detect `claude`. The env var and process tree checks should catch most real cases, but the fallback ordering creates a silent preference hierarchy.

### 1.2 Worktree Creation

`launchSingleItem()` creates a git worktree, allocates a partition, writes a temp system prompt, and launches the AI session.

**Finding W-3: Silent swallow of `fetchOrigin` and `ffMerge` failures (Medium)**
Lines 200-208 catch and discard errors from `fetchOrigin` and `ffMerge` with bare `catch {}` blocks. If the fetch fails (e.g., network down), the worktree is created from a stale local `main`. The worker will then work against outdated code and likely produce merge conflicts later. At minimum, these should log a warning so the user knows the worktree may be stale.

**Finding W-4: Branch collision handling deletes without confirmation (Low)**
Lines 211-220: if `branchExists(targetRepo, branchName)` is true, the branch is force-deleted and recreated. This is correct for recovery (e.g., a previous run left a stale branch), but could destroy work-in-progress if a worker is still active on that branch. The orchestrator's WIP tracking should prevent this, but `cmdStart` (the manual CLI command) has no such guard.

**Finding W-5: Prompt file race window (Low)**
The system prompt is written to `tmpdir()` (line 257) and deleted in a `finally` block (line 274). Between write and delete, the file is world-readable and contains the full TODO text. This is a minor information leak concern on shared systems. Using `mkdtemp` + restrictive permissions would be more defensive.

### 1.3 Session Launch

`launchAiSession()` dispatches by tool type, calls `mux.launchWorkspace()`, then `waitForReady()` + `sendMessage()`.

**Finding W-6: `waitForReady` timeout doesn't block — prompt sent anyway (Medium)**
Line 122-124: if `waitForReady` returns false (workspace never stabilized), the code warns but still sends the initial prompt. For Claude Code, this means sending "Start" before the tool is ready to receive input, which could be silently dropped. The current behavior is "best effort" — which is pragmatic — but there's no retry or verification that the initial prompt was received.

**Finding W-7: Shell injection via `safeTitle` in Claude command construction (Medium)**
Line 98 constructs a shell command string with `safeTitle` interpolated. The sanitization (line 242) strips `` ` ``, `$`, and `'` characters, but doesn't handle `"`, `\`, `;`, `|`, `&`, or newlines. Since the command string is passed through `mux.launchWorkspace()` which eventually hits a shell, a carefully crafted TODO title could inject additional commands. The sanitization should use allowlisting (keep only `[a-zA-Z0-9 _-]`) rather than blocklisting.

### 1.4 Test Coverage Assessment

- `detectAiTool`: env var priority tested, process tree walk NOT tested (mocking `ps` is hard)
- `launchSingleItem`: happy path + mux failure tested
- `cmdStart`: missing items, dependency validation tested
- **Gap:** no test for `extractTodoText` — edge cases like missing IDs, duplicate IDs, or malformed `###` headers
- **Gap:** no test for the shell command construction in `launchAiSession` — tool-specific command formats untested

---

## 2. Multiplexer Abstraction (`core/mux.ts`)

### 2.1 Interface Design

The `Multiplexer` interface defines 7 operations. Both `CmuxAdapter` and `TmuxAdapter` implement it. Detection uses an injectable `DetectMuxDeps` for testability.

**Observation:** The abstraction is clean and well-separated. DI via `DetectMuxDeps` and the `ShellRunner` injection on `TmuxAdapter` are good patterns.

### 2.2 TmuxAdapter

**Finding W-8: `TmuxAdapter.counter` is instance-scoped, not persistent (Low)**
The `counter` field (line 67) starts at 0 for each `TmuxAdapter` instance. Session names use `nw-${++this.counter}`, so names are `nw-1`, `nw-2`, etc. If the orchestrator crashes and restarts, a new `TmuxAdapter` instance reuses `nw-1` — which may collide with a still-running tmux session from the previous run. Using a random suffix or PID+timestamp would eliminate collisions.

**Finding W-9: TmuxAdapter `splitPane` returns wrong pane_id (Medium)**
Lines 92-108: `splitPane` runs `tmux split-window` followed by `tmux display-message -p '#{pane_id}'`. The `display-message` command operates on the currently active pane, but `split-window` may not activate the new pane depending on tmux configuration. This means the returned `pane_id` could reference the original pane, not the new split. The fix is to use `split-window -P -F '#{pane_id}'` which prints the new pane's ID directly.

**Finding W-10: TmuxAdapter `sendMessage` is susceptible to tmux key-timing issues (Low)**
Lines 110-123: the `-l` flag sends literal text, then a separate `send-keys Enter` submits. Unlike cmux's paste-buffer approach (which is atomic), tmux `send-keys -l` types character-by-character. For long messages, the Enter key can fire before all characters are typed. The cmux code has retry + verification for this exact issue; the tmux path doesn't.

### 2.3 `waitForReady`

**Finding W-11: `waitForReady` stability heuristic is fragile (Medium)**
Lines 258-282: the function waits for "3+ non-empty lines that are identical across two consecutive polls." This works for Claude Code's typical UI, but is sensitive to:
- Animated/blinking cursors (content changes every poll)
- Progress bars or status spinners
- Tools that render fewer than 3 lines initially

The `NODE_ENV === "test"` check for the sleep function (line 261) is a code smell — it couples runtime behavior to environment. The injectable sleep parameter is already the right pattern; the env check should be removed.

### 2.4 `getMux` Fallback Behavior

**Finding W-12: `getMux` fallback to CmuxAdapter masks real errors (Low)**
Lines 230-247: when no mux is available, `getMux` returns a `CmuxAdapter` whose `isAvailable()` returns false. This is documented but subtle — callers that forget to check `isAvailable()` will get silent failures (null returns, empty strings, false). An explicit `NullMux` adapter that throws descriptive errors on every method call would be more defensive.

### 2.5 Test Coverage Assessment

- `CmuxAdapter` delegation: all 7 methods tested
- `TmuxAdapter`: NOT tested (no tests in the test suite)
- `detectMuxType`: comprehensive (all 10 detection chain variants)
- `getMux`: comprehensive (6 scenarios)
- `waitForReady`: 4 scenarios tested
- **Gap:** `TmuxAdapter` has zero test coverage — all methods untested

---

## 3. Message Delivery (`core/cmux.ts`, `core/send-message.ts`)

### 3.1 Send Mechanism

`sendMessageImpl` implements a 3-step atomic send: `set-buffer` (load text) → `paste-buffer` (paste into workspace) → `send-key Return` (submit). With fallback to `cmux send` for TUI surfaces and retry with exponential backoff.

**Observation:** The paste-buffer approach is well-designed. It solves the fundamental keystroke-timing race condition. The fallback to `cmux send` for TUI surfaces is a reasonable degradation path.

### 3.2 Delivery Verification

`verifyDelivery` reads the last 3 screen lines and checks if the message text is still visible on the last line (indicating it's stuck in the input field, not yet submitted).

**Finding W-13: `verifyDelivery` false-negative when message appears in output (Low)**
Line 143-147: the probe checks if the first 60 chars of the message appear on the last screen line. If the AI tool echoes the received message (e.g., "Received: Rebase onto main please"), `verifyDelivery` would incorrectly detect a stuck message and trigger a retry — leading to duplicate message delivery. In practice, Claude Code doesn't echo raw messages in the last 3 lines, but other tools might.

**Finding W-14: `verifyDelivery` read-screen failure assumes success (Low)**
Lines 130-133: if `read-screen` fails, verification returns true (assumes success). This is pragmatic but means a broken cmux connection appears as "delivery confirmed." Combined with the retry logic, this could mask persistent delivery failures.

### 3.3 Retry Logic

**Observation:** The exponential backoff (100ms, 200ms, 400ms, default 3 retries) is well-calibrated. The `maxRetries` and `baseDelayMs` are injectable, enabling test control.

### 3.4 Test Coverage Assessment

- `sendMessageImpl`: 11 test cases covering happy path, retries, fallback, exhaustion
- `verifyDelivery`: 6 test cases covering all branches
- **Coverage is strong** for this module

---

## 4. Heartbeat Monitoring (`core/commands/orchestrate.ts`)

### 4.1 Worker Liveness

`isWorkerAlive` (line 203) checks if the worker's `workspaceRef` appears in `mux.listWorkspaces()`. This is the sole heartbeat signal.

**Finding W-15: No time-based heartbeat — only workspace existence (High)**
The liveness check is binary: workspace exists = alive, doesn't exist = dead. This means:
- A worker that is hung (infinite loop, deadlock, waiting forever) is considered "alive" as long as its workspace hasn't been closed
- There's no "making progress" signal based on commit activity or screen content changes
- The `lastCommitTime` field is tracked (line 191-193) but NOT used in transition logic — it's only stored for the supervisor to read

The state machine transitions from `implementing → stuck` only when `workerAlive === false && !prNumber` (orchestrator.ts line 317). A worker that launches successfully but then hangs indefinitely will never be detected as stuck. This is the single biggest reliability gap in the worker lifecycle.

**Finding W-16: `isWorkerAlive` uses substring match that could false-positive (Low)**
Line 207: `workspaces.includes(item.workspaceRef) || workspaces.includes(item.id)`. The `includes()` check on the full workspace listing string could match partial IDs. E.g., workspace ref `workspace:1` would match a line containing `workspace:10`. Using per-line matching or regex word boundaries would be more precise.

### 4.2 State Reconstruction After Crash

`reconstructState` (orchestrate.ts line 246) recovers orchestrator state from worktree existence + PR status. `recoverWorkspaceRef` scans the workspace list for the TODO ID.

**Observation:** The reconstruction logic is thorough — it handles all PR states and recovers workspace refs. The pre-fetch of `listWorkspaces()` (line 254) avoids N+1 shell calls.

**Finding W-17: `reconstructState` doesn't verify workspace is still responsive (Low)**
When recovering an `implementing` state, the code only checks if the workspace ref exists in the listing. It doesn't verify the workspace is responsive (e.g., by reading screen content). A zombie workspace would be recovered as "implementing" and potentially never cleaned up — same root cause as W-15.

---

## 5. Cleanup (`core/commands/clean.ts`)

### 5.1 Workspace Closing

`closeWorkspacesForIds` extracts TODO IDs from workspace names via regex and closes matching workspaces.

**Finding W-18: Workspace listing regex requires specific TODO ID format (Low)**
Line 33: `line.match(/TODO\s+([A-Z]+-[A-Za-z0-9]+-[0-9]+)/)` requires the `X-YYY-N` format. If a TODO ID uses a different format (e.g., no middle segment), the regex won't match and the workspace won't be cleaned up. The format is enforced elsewhere, but the regex doesn't match the canonical `ID_IN_PARENS` regex used by the parser.

### 5.2 Worktree Cleanup

`cleanItem` (line 149) checks merge status via git + GitHub, removes the worktree, deletes local/remote branches, releases partition, and removes cross-repo index entry.

**Finding W-19: Multiple silent `try/catch` blocks hide cleanup failures (Medium)**
Lines 157-175: worktree removal, branch deletion, and remote branch deletion each catch and ignore all errors. If `removeWorktree` throws but `rmSync` also fails (e.g., permission denied), the worktree directory persists but the cleanup reports success. The partition is released and the cross-repo index is updated, leaving an inconsistent state: partition freed but worktree still on disk.

At minimum, cleanup failures should be logged (not silently swallowed) so they surface during debugging.

**Finding W-20: `cmdClean` without target ID closes ALL todo workspaces before checking merge status (Medium)**
Lines 133-137: when no `targetId` is specified, `cmdCloseWorkspaces(mux)` is called first — which closes ALL workspaces matching `TODO <ID>` patterns. Only THEN does the code check if worktrees are merged before removing them. This means active worker workspaces for non-merged items are killed before the merge check runs. The workspace close and worktree cleanup should be filtered to only target merged items (or at least warn before closing active ones).

### 5.3 Cross-repo Cleanup

**Observation:** The cross-repo cleanup path (lines 199-214) reads the `.cross-repo-index` file and cleans worktrees in other repos. The file-based index with lock protection (via `acquireLock`) is a pragmatic approach for cross-process coordination.

**Finding W-21: Cross-repo index can grow unbounded (Low)**
`removeCrossRepoIndex` filters out lines by ID, but if cleanup never runs (e.g., manual branch deletion), entries accumulate. There's no periodic sweep to remove entries for non-existent worktrees. The `cleanupStalePartitions` function does this for partition locks but there's no equivalent for the cross-repo index.

### 5.4 Test Coverage Assessment

- `cmdCloseWorkspaces`: 3 scenarios tested
- `cmdCloseWorkspace`: 3 scenarios tested
- `cleanSingleWorktree`: 4 scenarios including error resilience
- `cmdCleanSingle`: 3 scenarios
- `cmdClean`: 5 scenarios including targeted cleanup
- **Gap:** no test for cross-repo worktree cleanup path (lines 199-214)
- **Gap:** `closeWorkspacesForIds` is only tested in `reconcile.test.ts`, not in `clean.test.ts`

---

## 6. Reconciliation (`core/commands/reconcile.ts`)

### 6.1 Core Reconcile Flow

`reconcile()` pulls latest main, queries GitHub for merged ninthwave/* PRs, marks merged items done, cleans worktrees, closes stale workspaces, and commits/pushes.

**Observation:** The DI pattern (`ReconcileDeps`) is excellent — every external dependency is injectable. The test suite uses this for comprehensive unit testing without shell calls.

### 6.2 Three-Way Merge

`mergeTodosThreeWay` resolves TODOS.md conflicts by computing set differences (added/removed items relative to base).

**Observation:** This is well-engineered. The realistic test case (line 914 in reconcile.test.ts) validates the core concurrent-mark-done scenario. The up-to-10-commit iterative resolve loop (line 247) handles multi-commit rebases.

**Finding W-22: Three-way merge doesn't preserve item content modifications (Medium)**
The merge only tracks additions and removals (by ID). If "ours" modifies an existing item's text (e.g., updates priority or description) while "theirs" doesn't change it, the modification is preserved because we use "ours" as the base document. But if "theirs" also modifies the same item's text differently, "theirs" changes are silently dropped — "ours" version wins. There's no content-level merge for individual items. This is documented by the design (set-based merge, not line-based), but could surprise users who edit TODO descriptions on different branches.

**Finding W-23: `defaultPullRebase` abort on non-TODOS.md conflicts could leave git in bad state (Low)**
Line 257: when non-TODOS.md files are conflicted, `rebase --abort` is called. But if the abort fails (e.g., corrupted git state), the function returns `{ ok: false, conflict: true }` without ensuring the repo is in a clean state. Subsequent operations may fail mysteriously.

### 6.3 `defaultCommitAndPush` Race Condition

**Finding W-24: Reconcile commit-and-push races with concurrent reconcile runs (Medium)**
The reconcile flow reads TODOS.md, marks items done, then stages/commits/pushes. If two reconcile processes run concurrently (e.g., two orchestrator instances), both could read the same TODOS.md, both mark the same items done, and one push will fail. The second reconcile would need to pull-rebase-retry, but `defaultCommitAndPush` doesn't retry on push failure — it just warns and returns false.

The three-way merge resolves the rebase conflict, but the commit-push sequence isn't atomic. This is mitigated by the fact that concurrent orchestrators are unlikely in practice, but the code doesn't defend against it.

### 6.4 Test Coverage Assessment

- `reconcile`: 12 test cases covering all branches
- `parseTodosForMerge`: 4 test cases
- `mergeTodosThreeWay`: 9 test cases including realistic scenarios
- `closeWorkspacesForIds`: 6 test cases
- **Coverage is strong** — this is the best-tested module in the worker lifecycle

---

## 7. Multiplexer Edge Cases (cmux vs tmux)

### 7.1 Feature Parity

| Operation | CmuxAdapter | TmuxAdapter | Notes |
|-----------|-------------|-------------|-------|
| `isAvailable` | `cmux --version` | `tmux -V` | Both work |
| `launchWorkspace` | `cmux new-workspace` | `tmux new-session` | cmux returns `workspace:N`, tmux uses `nw-N` |
| `splitPane` | `cmux split-pane` | `tmux split-window` | tmux has pane_id bug (W-9) |
| `sendMessage` | Paste-buffer + verify | send-keys -l + Enter | tmux lacks delivery verification (W-10) |
| `readScreen` | `cmux read-screen` | `tmux capture-pane -p` | Both work |
| `listWorkspaces` | `cmux list-workspaces` | `tmux list-sessions` (filtered) | tmux filters to `nw-` prefix |
| `closeWorkspace` | `cmux close-workspace` | `tmux kill-session` | Both work |

**Finding W-25: tmux path lacks the delivery guarantees of cmux (High)**
The cmux path uses `sendMessageImpl` with paste-buffer + verification + retry. The tmux path uses `send-keys -l` without verification or retry. This means tmux users have significantly weaker message delivery guarantees. The orchestrator's ability to send CI fix requests, rebase requests, and stop requests to workers depends on reliable message delivery. Message loss on tmux would leave workers in stale states.

### 7.2 Session Naming Conflicts

**Finding W-26: tmux session names don't include TODO ID (Low)**
CmuxAdapter workspaces include the TODO title (via the `cmd` string), making them identifiable in `listWorkspaces`. TmuxAdapter uses `nw-1`, `nw-2`, etc. The `closeWorkspacesForIds` function relies on TODO ID appearing in the workspace listing — this works for cmux (where the command string includes the ID) but may not work reliably for tmux (where the session name is just `nw-N`). The workspace identification logic in `isWorkerAlive` and `closeWorkspacesForIds` assumes the listing contains the TODO ID, which is an assumption that only holds for cmux.

---

## Summary of Findings

| ID | Severity | Module | Summary |
|----|----------|--------|---------|
| W-1 | Medium | launch.ts | Process tree walk is platform-fragile |
| W-2 | Low | launch.ts | `which` fallback may detect wrong tool |
| W-3 | Medium | launch.ts | Silent swallow of fetch/merge failures |
| W-4 | Low | launch.ts | Branch collision deletes without confirmation |
| W-5 | Low | launch.ts | Prompt file is world-readable in tmpdir |
| W-6 | Medium | launch.ts | `waitForReady` timeout still sends prompt |
| W-7 | Medium | launch.ts | Shell injection via TODO title in command construction |
| W-8 | Low | mux.ts | TmuxAdapter counter resets on restart |
| W-9 | Medium | mux.ts | TmuxAdapter `splitPane` returns wrong pane_id |
| W-10 | Low | mux.ts | TmuxAdapter `sendMessage` has keystroke timing issues |
| W-11 | Medium | mux.ts | `waitForReady` stability heuristic is fragile |
| W-12 | Low | mux.ts | `getMux` fallback masks errors |
| W-13 | Low | send-message.ts | `verifyDelivery` false-negative on echoed messages |
| W-14 | Low | send-message.ts | Read-screen failure assumes delivery success |
| W-15 | High | orchestrate.ts | No time-based heartbeat for stuck worker detection |
| W-16 | Low | orchestrate.ts | `isWorkerAlive` substring match may false-positive |
| W-17 | Low | orchestrate.ts | State reconstruction doesn't verify workspace is responsive |
| W-18 | Low | clean.ts | Workspace regex doesn't match canonical ID format |
| W-19 | Medium | clean.ts | Silent catch blocks hide cleanup failures |
| W-20 | Medium | clean.ts | `cmdClean` kills active workspaces before merge check |
| W-21 | Low | clean.ts | Cross-repo index can grow unbounded |
| W-22 | Medium | reconcile.ts | Three-way merge drops concurrent item edits |
| W-23 | Low | reconcile.ts | Rebase abort may leave git in bad state |
| W-24 | Medium | reconcile.ts | Concurrent reconcile has commit-push race |
| W-25 | High | mux.ts | tmux path lacks delivery guarantees of cmux |
| W-26 | Low | mux.ts | tmux session names don't include TODO ID |

### Counts by Severity

- **High:** 2 (W-15, W-25)
- **Medium:** 10 (W-1, W-3, W-6, W-7, W-9, W-11, W-19, W-20, W-22, W-24)
- **Low:** 14 (W-2, W-4, W-5, W-8, W-10, W-12, W-13, W-14, W-16, W-17, W-18, W-21, W-23, W-26)

### Test Coverage Summary

| Module | Coverage | Notable Gaps |
|--------|----------|--------------|
| `launch.ts` | Medium | `extractTodoText` untested, `launchAiSession` command construction untested |
| `mux.ts` | Medium-High | `TmuxAdapter` has zero test coverage |
| `send-message.ts` | High | Strong DI-based test coverage |
| `clean.ts` | Medium-High | Cross-repo cleanup path untested |
| `reconcile.ts` | High | Best-tested module, comprehensive three-way merge tests |
| `orchestrate.ts` (worker parts) | Low | `isWorkerAlive`, `reconstructState` tested only via integration |
