# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Operational Maturity (vision exploration, 2026-03-24)



### Feat: Automatic worker retry on crash or OOM (M-RET-1)

**Priority:** Medium
**Source:** Vision — resilience improvement for production use
**Depends on:** H-WIP-1

When a worker transitions to "stuck" due to heartbeat timeout or workspace death, automatically retry once before marking as permanently stuck. Clean up the failed worktree, create a fresh one, and relaunch the worker. Add `retryCount` to `OrchestratorItem` and `maxRetries` to `OrchestratorConfig` (default: 1). Log retries as structured events. Only mark as permanently stuck after exhausting retries.

**Test plan:**
- Unit test: stuck worker triggers retry transition when retryCount < maxRetries
- Unit test: retry creates fresh worktree and relaunches worker
- Unit test: permanently stuck after maxRetries exhausted
- Unit test: retryCount is tracked in item metrics for analytics
- Edge case: worker crashes during retry (second attempt counts correctly)

Acceptance: Workers that crash are retried once automatically with a fresh worktree. Retry count is tracked per item and reflected in analytics. Items are permanently stuck only after exhausting retries. Retries are logged as structured events. Tests pass. No regression in orchestrator state machine tests.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `core/commands/clean.ts`

---

## Data Pipeline Hardening (eng review M-ENG-3, 2026-03-24)



### Fix: Parser should warn on skipped items with missing IDs (M-DP-1)

**Priority:** Medium
**Source:** Eng review M-ENG-3 finding 1.1
**Depends on:** None

When an item in TODOS.md has no ID (e.g., `### Feat: Item with no ID`), `parseTodos` silently skips it. Add an optional `warn` callback parameter to `parseTodos` (consistent with the DI pattern) that is called when items are skipped due to missing ID, including the line number for diagnostics.

**Test plan:**
- Unit test: warn callback is invoked with line number when an item has no ID
- Unit test: parsing continues correctly after warning
- Unit test: warn is not called for valid items

Acceptance: `parseTodos` accepts an optional warn callback. Callback is invoked with a descriptive message and line number when items are skipped. Existing tests continue to pass (no warn = no change in behavior). New tests cover the warning behavior.

Key files: `core/parser.ts`, `test/parser.test.ts`

---

### Fix: Parser should detect and warn on duplicate IDs (M-DP-2)

**Priority:** Medium
**Source:** Eng review M-ENG-3 finding 1.2
**Depends on:** None

If two items share the same ID, both are added to the items array. Downstream consumers using `Map(items.map(i => [i.id, i]))` silently pick the last one. Add duplicate detection during parsing: warn on the second occurrence and skip it.

**Test plan:**
- Unit test: duplicate ID triggers warning via warn callback
- Unit test: first item is kept, duplicate is skipped
- Unit test: parsing continues after duplicate is detected
- Add a `duplicate_ids.md` fixture

Acceptance: Duplicate IDs are detected and the duplicate is skipped with a warning. First occurrence is kept. Tests cover the duplicate detection behavior. No regression in existing parser tests.

Key files: `core/parser.ts`, `test/parser.test.ts`, `test/fixtures/duplicate_ids.md`

---

### Refactor: Remove dead `projectRoot` variable in parseTodos (L-DP-3)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 1.3
**Depends on:** None

Line 251 of `core/parser.ts` computes `const projectRoot = join(todosFile, "..", "..")` which is never used. Remove the dead variable.

Acceptance: Dead variable is removed. No behavioral change. Tests pass.

Key files: `core/parser.ts`

---

### Fix: Title regex stripping is too greedy after ID pattern (L-DP-4)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 1.4
**Depends on:** None

The title-cleaning regex `/ \([A-Z]*-[A-Za-z0-9]*-[0-9]*.*/` uses `.*` after the ID pattern, which strips everything after the first ID-like parenthetical. For example, `### Feat: Migration (M-DB-1) (phase 2)` produces `Feat: Migration` instead of `Feat: Migration (phase 2)`. Make the regex match only the ID parenthetical and known suffixes.

**Test plan:**
- Unit test: title with ID followed by extra parentheticals preserves the extras
- Unit test: existing title extraction still works for standard format

Acceptance: Title extraction preserves non-ID parenthetical content. Existing title tests continue to pass. New test covers the edge case.

Key files: `core/parser.ts`, `test/parser.test.ts`

---

### Fix: Parser should strip UTF-8 BOM from TODOS.md (L-DP-5)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 1.5
**Depends on:** None

If TODOS.md starts with a UTF-8 BOM (`\uFEFF`), the first `## ` header check fails because the BOM character precedes it. Strip BOM from content at the start of `parseTodos`.

**Test plan:**
- Unit test: TODOS.md with BOM prefix parses correctly
- Unit test: TODOS.md without BOM is unaffected

Acceptance: BOM is stripped before parsing. Tests pass with both BOM and non-BOM input.

Key files: `core/parser.ts`, `test/parser.test.ts`

---

### Fix: Tighten parseCostSummary regex to avoid false positives (L-DP-6)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 2.1
**Depends on:** None

The token-matching regex `tokens?\s*[:=]\s*([\d,]+)` can match false positives like "CSRF token: 12345". Anchor the match more tightly — require "total tokens" or a more specific prefix to reduce false positives.

**Test plan:**
- Unit test: "CSRF token: 12345" does not produce a token count
- Unit test: "Total tokens: 42,567" still matches correctly
- Unit test: existing cost parsing tests still pass

Acceptance: False positive cases are rejected. Legitimate cost summaries are still parsed correctly. Tests cover both cases.

Key files: `core/analytics.ts`, `test/analytics.test.ts`

---

### Fix: commitAnalyticsFiles should unstage on dirty_index (L-DP-7)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 2.2
**Depends on:** None

When `commitAnalyticsFiles` detects non-analytics staged files and returns `dirty_index`, it leaves the analytics files staged. Add an unstage step (via an injectable `gitReset` dep) before returning `dirty_index`.

**Test plan:**
- Unit test: analytics files are unstaged when dirty_index is returned
- Unit test: existing commit behavior unchanged for clean index

Acceptance: Analytics files are unstaged when returning `dirty_index`. Existing tests pass. New test verifies the unstage behavior.

Key files: `core/analytics.ts`, `test/analytics.test.ts`

---

### Fix: Analytics loadRuns should validate JSON structure and warn on corrupt files (L-DP-8)

**Priority:** Low
**Source:** Eng review M-ENG-3 findings 2.3 and 3.2
**Depends on:** None

`loadRuns` does minimal validation (only checks `runTimestamp` and `wallClockMs`) and silently skips corrupt files. Add structural validation (items array exists, each item has id and state) and an optional warn callback for corrupt/skipped files.

**Test plan:**
- Unit test: file with valid timestamp but missing items array is skipped with warning
- Unit test: file with malformed item entries is skipped with warning
- Unit test: valid files are loaded as before

Acceptance: Corrupt analytics files are skipped with a diagnostic warning. Valid files load normally. Tests cover corrupt file scenarios.

Key files: `core/commands/analytics.ts`, `test/analytics.test.ts`

---

### Fix: Webhook fireWebhook should have a fetch timeout (M-DP-9)

**Priority:** Medium
**Source:** Eng review M-ENG-3 finding 4.1
**Depends on:** None

`fireWebhook` calls fetch without a timeout. If the webhook endpoint hangs, the promise stays pending indefinitely, accumulating resources. Add an `AbortController` with a 10-second timeout to the fetch call.

**Test plan:**
- Unit test: fetch that exceeds timeout is aborted and error is logged
- Unit test: fast responses work normally
- Unit test: existing webhook tests pass

Acceptance: Fetch calls have a 10-second timeout via AbortController. Timeout triggers abort and logs an error. No change to behavior for fast responses. Tests cover timeout scenario.

Key files: `core/webhooks.ts`, `test/webhooks.test.ts`

---

### Feat: Webhook rate limiting / debounce for rapid events (L-DP-10)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 4.2
**Depends on:** None

Rapid orchestration events can fire multiple webhooks per second, exceeding Slack/Discord rate limits. Add a simple debounce window (e.g., 2 seconds) to `createWebhookNotifier` that coalesces rapid events into batched payloads.

**Test plan:**
- Unit test: rapid events within window are coalesced into one webhook
- Unit test: events outside window are sent individually
- Unit test: all event data is preserved in coalesced payload

Acceptance: Rapid webhook events are debounced. Coalesced payloads contain all event data. Single events are sent immediately after the debounce window. Tests cover both scenarios.

Key files: `core/webhooks.ts`, `test/webhooks.test.ts`

---

### Fix: Validate webhook URL format on resolve (L-DP-11)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 4.3
**Depends on:** None

`resolveWebhookUrl` returns raw strings from env or config without URL validation. Invalid URLs fail at fetch time with unclear errors. Add URL format validation using `new URL()` and return null (with warning) for invalid URLs.

**Test plan:**
- Unit test: invalid URL string returns null
- Unit test: valid HTTP/HTTPS URLs pass validation
- Unit test: existing tests pass

Acceptance: Invalid URLs are caught at resolve time with a descriptive warning. Valid URLs work as before. Tests cover invalid URL scenarios.

Key files: `core/webhooks.ts`, `test/webhooks.test.ts`

---

### Refactor: Pre-compile template keyword regexes at load time (L-DP-12)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 5.1
**Depends on:** None

In `matchTemplates`, a new `RegExp` is constructed for each single-word keyword on each call. Pre-compile keyword regexes in `parseTemplate` and store them on the `DecompositionTemplate` object for better performance.

**Test plan:**
- Unit test: matching behavior is unchanged
- Unit test: pre-compiled regexes produce same results as dynamic construction

Acceptance: Keyword regexes are compiled once at template load time. All existing template matching tests pass without modification.

Key files: `core/templates.ts`, `test/templates.test.ts`

---

### Fix: Strip Keywords section from template body (L-DP-13)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 5.2
**Depends on:** None

The `body` field stores the full markdown content including the `## Keywords` section. When templates are rendered to users, this metadata section is confusing. Strip it during parsing.

**Test plan:**
- Unit test: parsed template body does not contain `## Keywords` section
- Unit test: template body preserves all other sections

Acceptance: Template body excludes the Keywords section. All other content is preserved. Tests verify the stripping behavior.

Key files: `core/templates.ts`, `test/templates.test.ts`

---

### Refactor: Replace die() with throw in resolveRepo (M-DP-14)

**Priority:** Medium
**Source:** Eng review M-ENG-3 finding 6.1
**Depends on:** None

`resolveRepo` calls `die()` (which calls `process.exit(1)`) when a repo alias cannot be resolved. This makes error handling impossible for callers and makes the function difficult to test. Replace `die()` with `throw new Error(...)` and let callers decide how to handle the failure.

**Test plan:**
- Unit test: resolveRepo throws on unresolvable alias (instead of process.exit)
- Unit test: callers can catch the error and continue
- Verify all call sites handle the thrown error appropriately

Acceptance: `resolveRepo` throws instead of calling `die()`. All call sites catch and handle the error. Tests cover the error paths. No regression in cross-repo functionality.

Key files: `core/cross-repo.ts`, `test/cross-repo.test.ts`

---

### Fix: Cross-repo index should deduplicate entries on write (L-DP-15)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 6.2
**Depends on:** None

`writeCrossRepoIndex` appends entries without checking for existing entries with the same ID. Add a deduplication check: if an entry with the same ID already exists, update it rather than appending a duplicate.

**Test plan:**
- Unit test: writing same ID twice results in one entry
- Unit test: writing different IDs produces separate entries
- Unit test: existing index operations still work

Acceptance: Duplicate entries are prevented. Writing an existing ID updates the entry. Tests cover deduplication behavior.

Key files: `core/cross-repo.ts`, `test/cross-repo.test.ts`

---

### Feat: Config key validation with unknown key warnings (L-DP-16)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 7.2
**Depends on:** None

Unknown config keys (e.g., typos) are silently accepted. Add a known-keys list and warn when unrecognized keys are found in `.ninthwave/config`.

**Test plan:**
- Unit test: known keys are accepted without warning
- Unit test: unknown keys trigger a warning
- Unit test: existing config loading behavior is preserved

Acceptance: Unrecognized config keys produce a diagnostic warning. Known keys work as before. Tests cover both cases.

Key files: `core/config.ts`, `test/config.test.ts`

---

### Refactor: Consolidate domain file parsing — normalizeDomain should accept a Map (L-DP-17)

**Priority:** Low
**Source:** Eng review M-ENG-3 finding 7.3
**Depends on:** None

`normalizeDomain` reads and parses `domains.conf` directly from disk, duplicating the logic in `loadDomainMappings()`. Refactor `normalizeDomain` to accept a `Map<string, string>` parameter instead of a file path, and have `parseTodos` call `loadDomainMappings` once and pass the result.

**Test plan:**
- Unit test: normalizeDomain with Map produces same results as with file path
- Unit test: parseTodos loads domain mappings once and passes them through
- Integration: existing domain mapping tests pass

Acceptance: Domain file is read once per parse call. `normalizeDomain` accepts a Map. `loadDomainMappings` is the single source of file-parsing logic. All existing tests pass.

Key files: `core/parser.ts`, `core/config.ts`, `test/parser.test.ts`, `test/config.test.ts`

---

## Worker Reliability (eng-review-workers, 2026-03-24)



### Fix: Sanitize TODO title with allowlist to prevent shell injection (H-WRK-1)

**Priority:** High
**Source:** Eng review W-7 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`launchAiSession` in `core/commands/start.ts` (line 98) interpolates `safeTitle` into a shell command string. The current sanitization (line 242) only strips `` ` ``, `$`, and `'` but doesn't handle `"`, `\`, `;`, `|`, `&`, or newlines. Switch to an allowlist approach: replace everything except `[a-zA-Z0-9 _-]` with `_`.

**Test plan:**
- Unit test: titles with shell metacharacters (`"`, `\`, `;`, `|`, `&`, newlines) are sanitized
- Unit test: normal titles pass through unchanged
- Unit test: empty title produces safe output

Acceptance: `safeTitle` sanitization uses an allowlist (`[a-zA-Z0-9 _-]`). Shell metacharacters are replaced, not just stripped. Tests cover all common injection vectors. No regression in start tests.

Key files: `core/commands/start.ts`, `test/start.test.ts`

---

### Feat: Add time-based heartbeat for stuck worker detection (H-WRK-2)

**Priority:** High
**Source:** Eng review W-15 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

The current liveness check is binary (workspace exists = alive). A worker that launches but hangs indefinitely is never detected as stuck. Add a time-based heartbeat: if `lastCommitTime` is null and the worker has been in `implementing` state for longer than a configurable timeout (e.g., 30 minutes), or if `lastCommitTime` is stale beyond a longer timeout (e.g., 60 minutes), transition to `stuck`. The `lastCommitTime` field is already tracked in `buildSnapshot` but not used in transition logic.

**Test plan:**
- Unit test: worker with no commits after launch timeout transitions to stuck
- Unit test: worker with stale commit beyond activity timeout transitions to stuck
- Unit test: worker with recent commits stays in implementing
- Unit test: timeout values are configurable via `OrchestratorConfig`
- Edge case: worker that just launched (within grace period) is not marked stuck

Acceptance: Workers that hang without making commits are detected as stuck after a configurable timeout. `OrchestratorConfig` has `launchTimeoutMs` and `activityTimeoutMs` fields. State machine uses `lastCommitTime` and `lastTransition` timestamps for stuck detection. Tests pass. No regression.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `test/orchestrator.test.ts`

---

### Fix: Add delivery verification and retry to TmuxAdapter sendMessage (H-WRK-3)

**Priority:** High
**Source:** Eng review W-25 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

The tmux `sendMessage` uses `send-keys -l` without delivery verification or retry, while cmux has paste-buffer + verify + exponential backoff. Extract the verification logic from `send-message.ts` into a shared utility and wire it into `TmuxAdapter.sendMessage`. Alternatively, have `TmuxAdapter` use tmux's `load-buffer` + `paste-buffer` approach (analogous to cmux's atomic paste) with verification.

**Test plan:**
- Unit test: TmuxAdapter sendMessage verifies delivery via readScreen
- Unit test: TmuxAdapter retries on failed delivery
- Unit test: TmuxAdapter falls back gracefully when verification fails
- Integration: message delivery works end-to-end on tmux

Acceptance: `TmuxAdapter.sendMessage` includes delivery verification and retry with exponential backoff. Tmux and cmux paths have equivalent delivery guarantees. Tests cover retry and verification scenarios. No regression.

Key files: `core/mux.ts`, `core/send-message.ts`, `test/mux.test.ts`

---

### Fix: Log warnings on fetch/merge failures during worktree creation (M-WRK-4)

**Priority:** Medium
**Source:** Eng review W-3 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`launchSingleItem` in `core/commands/start.ts` (lines 200-208) silently catches `fetchOrigin` and `ffMerge` failures. A network failure means the worktree is created from stale local `main`, leading to merge conflicts later. Replace bare `catch {}` with `catch { warn(...) }` so users see that the worktree may be based on outdated code.

**Test plan:**
- Unit test: fetch failure logs a warning but continues
- Unit test: ff-merge failure logs a warning but continues
- Verify warning message includes actionable context

Acceptance: `fetchOrigin` and `ffMerge` failures log warnings with `warn()`. Worktree creation still proceeds. Tests verify warnings are emitted. No regression.

Key files: `core/commands/start.ts`, `test/start.test.ts`

---

### Fix: TmuxAdapter splitPane returns correct pane ID (M-WRK-5)

**Priority:** Medium
**Source:** Eng review W-9 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`TmuxAdapter.splitPane` (mux.ts lines 92-108) runs `tmux split-window` then `tmux display-message -p '#{pane_id}'` to get the new pane's ID. But `display-message` returns the active pane's ID, which may not be the newly created pane. Fix by using `tmux split-window -P -F '#{pane_id}'` which prints the new pane's ID as output.

**Test plan:**
- Unit test: splitPane returns the pane ID from split-window output
- Unit test: splitPane returns fallback when -P flag output is empty
- Verify via injected ShellRunner mock

Acceptance: `TmuxAdapter.splitPane` uses `split-window -P -F '#{pane_id}'` and returns the correct pane ID. Tests verify correct pane ID is returned. No regression.

Key files: `core/mux.ts`, `test/mux.test.ts`

---

### Fix: Log cleanup failures instead of silently swallowing (M-WRK-6)

**Priority:** Medium
**Source:** Eng review W-19 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`cleanItem` in `core/commands/clean.ts` (lines 157-175) has multiple `try/catch` blocks that silently ignore errors from `removeWorktree`, `deleteBranch`, and `deleteRemoteBranch`. Replace bare `catch {}` with `catch (e) { warn(...) }` so cleanup failures are visible. The cleanup should still continue on error (resilient), but should not be silent.

**Test plan:**
- Unit test: removeWorktree failure logs warning and continues
- Unit test: deleteBranch failure logs warning and continues
- Unit test: deleteRemoteBranch failure logs warning and continues
- Verify cleanup completes even when all operations fail

Acceptance: All `catch {}` blocks in `cleanItem` and `cleanSingleWorktree` log warnings. Cleanup still completes on failure (resilient behavior preserved). Tests verify warnings. No regression.

Key files: `core/commands/clean.ts`, `test/clean.test.ts`

---

### Fix: Scope cmdClean workspace closing to merged items only (M-WRK-7)

**Priority:** Medium
**Source:** Eng review W-20 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`cmdClean` without a target ID calls `cmdCloseWorkspaces(mux)` which kills ALL todo workspaces before checking merge status. Active workers for non-merged items are killed. Fix by deferring workspace closure: close workspaces only for items whose branches are confirmed merged, or at minimum warn before closing active workspaces.

**Test plan:**
- Unit test: cmdClean without target only closes workspaces for merged worktrees
- Unit test: active workers for non-merged items are not killed
- Unit test: targeted cleanup (with ID) still closes the specific workspace

Acceptance: `cmdClean` (without target ID) only closes workspaces for items that are confirmed merged. Non-merged worker workspaces are preserved. Tests cover both targeted and broad cleanup. No regression.

Key files: `core/commands/clean.ts`, `test/clean.test.ts`

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

### Fix: Use word-boundary matching in isWorkerAlive (L-WRK-9)

**Priority:** Low
**Source:** Eng review W-16 — `docs/reviews/eng-review-workers.md`
**Depends on:** None

`isWorkerAlive` in `core/commands/orchestrate.ts` (line 207) uses `workspaces.includes(item.workspaceRef)` which is a substring match on the entire listing string. `workspace:1` would match `workspace:10`. Fix by splitting the listing into lines and doing per-line matching, or use regex word boundaries.

**Test plan:**
- Unit test: workspace:1 does not match workspace:10
- Unit test: exact workspace ref matches correctly

Acceptance: `isWorkerAlive` uses per-line matching or word-boundary regex. No false positives from partial ID matches. Tests cover the edge case. No regression.

Key files: `core/commands/orchestrate.ts`, `test/orchestrator.test.ts`

---

## Orchestrator Review Findings (eng-review H-ENG-1, 2026-03-24)



### Fix: Add timeout support to shell.ts run() (H-SHL-1)

**Priority:** High
**Source:** Eng review H-ENG-1 — finding F5
**Depends on:** None

`Bun.spawnSync` in `run()` can block indefinitely. Git commands that prompt for SSH credentials, encounter network timeouts, or deadlock on large repos will hang the orchestrator's event loop. Since the event loop is single-threaded, a single hung command blocks all processing. Add an optional `timeout` parameter to `run()` with sensible defaults (30s for git, 60s for gh). Use Bun's `timeout` option in `spawnSync`. Return a timeout-specific error that callers can handle.

**Test plan:**
- Unit test: run() with timeout kills process and returns non-zero exit code after timeout
- Unit test: run() without timeout still works (backward compatible)
- Unit test: timeout error message is distinguishable from normal exit code errors
- Edge case: very short timeout (1ms) doesn't cause flaky behavior

Acceptance: `run()` accepts an optional `timeout` parameter. Commands that exceed the timeout are killed and return a timeout error. Existing callers are unaffected (no breaking changes). Tests pass.

Key files: `core/shell.ts`, `test/shell.test.ts`

---

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

### Fix: Guard asap merge strategy against CHANGES_REQUESTED (H-ORC-2)

**Priority:** High
**Source:** Eng review H-ENG-1 — finding F3
**Depends on:** None

With `mergeStrategy: "asap"`, `evaluateMerge` triggers a merge when CI passes regardless of review state. A PR with explicit "changes requested" review decision would still be auto-merged. In repos without branch protection, this could merge PRs that a human explicitly flagged for revision. Add a guard: if `reviewDecision === "CHANGES_REQUESTED"`, transition to `review-pending` instead of merging, even with `asap` strategy. This respects explicit human feedback in all modes.

**Test plan:**
- Unit test: asap strategy with CHANGES_REQUESTED → review-pending (not merging)
- Unit test: asap strategy with no review → merging (unchanged behavior)
- Unit test: asap strategy with APPROVED → merging (unchanged behavior)
- Unit test: asap strategy with REVIEW_REQUIRED → merging (unchanged, no explicit rejection)

Acceptance: The `asap` merge strategy no longer auto-merges PRs with `CHANGES_REQUESTED`. Other review states are unchanged. Tests pass. No regression in existing merge strategy tests.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Fix: Persist ciFailCount across crash recovery (M-REC-1)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F11
**Depends on:** None

`reconstructState` rebuilds items from disk/GitHub but resets `ciFailCount` to 0. After a restart, an item that already exhausted its CI retries gets a fresh budget, wasting CI resources on persistently failing items. The daemon state file already serializes item state via `serializeOrchestratorState`. Extend it to include `ciFailCount` and restore it during `reconstructState` when the state file is available.

**Test plan:**
- Unit test: ciFailCount is included in serialized daemon state
- Unit test: reconstructState restores ciFailCount from state file when available
- Unit test: reconstructState defaults to 0 when no state file exists
- Edge case: state file has higher ciFailCount than maxCiRetries (item goes stuck immediately)

Acceptance: `ciFailCount` survives orchestrator restarts when daemon state file is present. Items that exhausted retries before a crash don't get additional retries. Serialization format is backward-compatible. Tests pass.

Key files: `core/daemon.ts`, `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

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

### Test: Add single-cycle multi-step chaining test (H-TST-1)

**Priority:** High
**Source:** Eng review H-ENG-1 — finding F1
**Depends on:** None

When `handleImplementing` detects a PR, it falls through to `handlePrLifecycle`. An item can chain through implementing → pr-open → ci-passed → merging in one `processTransitions` call with `asap` strategy. This optimization is correct but untested. Add a dedicated test.

**Test plan:**
- Unit test: implementing item with snapshot containing prNumber, prState: "open", ciStatus: "pass" reaches "merging" in one processTransitions call (asap strategy)
- Unit test: same scenario with "approved" strategy reaches "review-pending"
- Unit test: same scenario with ciStatus: "pending" reaches "ci-pending" (not further)

Acceptance: Multi-step chaining from implementing through merge evaluation is tested for all three merge strategies. Tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

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

## Vision (recurring, 2026-03-24)



### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-5)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** ANL-*, WIP-*, GHI-*, DAE-*, RET-*, ENG-*, DP-*

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-6, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`, `vision.md`

---
