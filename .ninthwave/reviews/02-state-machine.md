# Review 2: Core State Machine

## Summary

The Orchestrator class (`core/orchestrator.ts`, 2,662 LOC) is a well-structured state machine with a clean pure/impure separation: `processTransitions()` computes actions from snapshots, and `executeAction()` performs side effects via injected dependencies. The design faithfully follows the "deterministic core, advisory AI" ethos (ETHOS.md principle #3).

The state machine has 19 states in code (the `OrchestratorItemState` union at lines 22-41) but only 16 are documented in ARCHITECTURE.md. Three states -- `repairing`, `verify-failed`, and `repairing-main` -- were added after the docs were written and are undocumented. All 19 states are reachable through explicit transition paths; there are no dead states.

The most significant issues found are: (1) a WIP accounting gap where `reviewing` is excluded from `WIP_STATES` but consumes the same resources, (2) `stuckOrRetry` not resetting `lastCommitTime`, creating a stale-timeout risk for retried workers, (3) `executeMerge` performing multiple non-atomic external operations where a mid-sequence failure leaves inconsistent state, and (4) the priority merge queue potentially starving lower-priority items. These are design-level concerns, not bugs in the current behavior.

Cross-reference: Review 1 identified that `OrchestratorItem` has 30+ optional fields with no state-discriminated enforcement (Finding 12). This review confirms that the flat-optional approach works in practice because `transitionItem` exhaustively matches all states and the `transition()` method manages flag lifecycles correctly. The flags themselves are the concern -- see Findings 2 and 8 below.

## Findings

### 1. ARCHITECTURE.md is out of date: 3 states undocumented -- SEVERITY: medium
**Tag:** SIMPLIFY

The `OrchestratorItemState` type union (lines 22-41) defines 19 states:

```
queued, ready, bootstrapping, launching, implementing, pr-open,
ci-pending, ci-passed, ci-failed, repairing, review-pending,
reviewing, merging, merged, verifying, verify-failed, repairing-main,
done, stuck
```

ARCHITECTURE.md's state table lists only 16, missing:
- **`repairing`** (line 32) -- repair worker resolving rebase conflicts
- **`verify-failed`** (line 38) -- post-merge CI failure on main detected
- **`repairing-main`** (line 39) -- verifier worker fixing post-merge CI

Additionally, the ARCHITECTURE.md "Stacked Launches" section (line 78) lists `implementing`, `pr-open`, `ci-pending`, `ci-passed`, `ci-failed` as stackable states, but the actual `STACKABLE_STATES` set (lines 449-453) is only `ci-passed`, `review-pending`, `merging` -- a significantly more conservative set.

The WIP_STATES set also diverges from the ARCHITECTURE.md listing. ARCHITECTURE.md (line 74) includes `bootstrapping` and `review-pending` but omits `repairing` and `merging`. The actual `WIP_STATES` set (lines 434-445) includes `bootstrapping`, `launching`, `implementing`, `pr-open`, `ci-pending`, `ci-passed`, `ci-failed`, `repairing`, `review-pending`, `merging`.

**Recommendation:** Update ARCHITECTURE.md with all 19 states, correct `STACKABLE_STATES`, and correct WIP state list. Estimated effort: ~30 LOC in docs.

### 2. stuckOrRetry does not reset lastCommitTime -- SEVERITY: high
**Tag:** SIMPLIFY

`stuckOrRetry()` (lines 941-953) resets `lastAliveAt` and `notAliveCount` but does **not** reset `lastCommitTime`. When a worker is retried, the new worker instance inherits the stale `lastCommitTime` from the previous attempt.

In `handleImplementing()` (lines 924-930), when `commitTime` exists:
```typescript
const sinceCommit = nowMs - new Date(commitTime).getTime();
if (sinceCommit > this.config.activityTimeoutMs) {
  return this.stuckOrRetry(item, "worker-stalled: ...");
}
```

If the previous worker's last commit was 55 minutes ago (just under the 60-minute `activityTimeoutMs`), and the retry happens at minute 56, the new worker has only 4 minutes before hitting the activity timeout -- even though it just started.

The `commitTime` is resolved from `snap?.lastCommitTime ?? item.lastCommitTime` (line 899). The snapshot will report the same commit time since the branch hasn't changed. The new worker hasn't had time to push a new commit.

**Recommendation:** Reset `item.lastCommitTime = undefined` in `stuckOrRetry()` alongside `lastAliveAt` and `notAliveCount`. This forces the timeout to fall back to `lastTransition` for the fresh attempt. Alternatively, `stuckOrRetry` could set `item.lastCommitTime = null` and have `handleImplementing` treat `null` as "no commits from this attempt". Estimated effort: ~3 LOC.

### 3. WIP accounting gap: reviewing state not counted -- SEVERITY: medium
**Tag:** QUESTIONABLE

The `WIP_STATES` set (lines 434-445) does not include `reviewing`. Review workers have their own separate limit (`reviewWipLimit`, default 2, tracked via `reviewWipCount` at line 597). However, review workers consume the same system resources as implementation workers (memory, CPU, terminal sessions).

With `wipLimit=4` and `reviewWipLimit=2`, the system could run 4 implementation workers + 2 review workers = 6 concurrent sessions. The `calculateMemoryWipLimit()` function (lines 416-424) only adjusts `wipLimit` based on free memory, not the combined load.

This is a design decision, not a bug -- the separate tracking allows fine-grained control. But users on memory-constrained machines may see OOM with the default settings.

**Recommendation:** Either (a) include `reviewing` in WIP_STATES and remove `reviewWipLimit` (simpler model), or (b) have `calculateMemoryWipLimit` account for both limits. Option (b) preserves the current "review workers don't block implementation launches" behavior. This is a product decision. Tag as QUESTIONABLE.

### 4. processTransitions order: items can transition to ready and launch in the same cycle -- SEVERITY: medium
**Tag:** KEEP

`processTransitions()` (lines 612-655) processes items in three phases:
1. `transitionItem()` for all tracked items (line 622-626)
2. Promote queued → ready for items with deps met (lines 629-643)
3. `launchReadyItems()` fills WIP slots (line 647)

An item can transition from `queued` → `ready` in phase 2, then immediately get launched in phase 3 (ready → launching/bootstrapping). This means a single `processTransitions` call can move an item through `queued → ready → launching`.

However, this does NOT allow exceeding the WIP limit. `launchReadyItems()` (lines 2624-2648) checks `this.wipSlots` which reads the live `wipCount`. Since `launching` is in `WIP_STATES`, each launch decrements the remaining slots before the next iteration. This is correct.

**One subtle case:** `transitionItem` can move items to `done`/`stuck` (freeing WIP slots), then phase 3 can immediately fill those freed slots with new launches. This is a feature, not a bug -- it maximizes throughput. But it means a single poll cycle can have both `clean` and `launch` actions, which the execution layer must handle in order.

**Recommendation:** Keep as-is. Document the multi-phase behavior if contributors find it surprising. The WIP limit is correctly enforced.

### 5. Priority merge queue may starve lower-priority items -- SEVERITY: medium
**Tag:** SIMPLIFY

`prioritizeMergeActions()` (lines 2509-2533) serializes merges: when multiple items are ready to merge in the same cycle, only the highest-priority one proceeds. Others are reverted from `merging` → `ci-passed`.

**Starvation scenario:** If high-priority items continuously cycle through `ci-failed → ci-passed → merging`, lower-priority items that are also `ci-passed` will be repeatedly deferred. Each deferral reverts them to `ci-passed`, and the next cycle may defer them again.

In practice this is unlikely because merging is fast (gh pr merge + ff) and a successfully merged high-priority item is removed from the queue. But if a high-priority item's merge fails due to conflicts (non-fatal, goes back to `ci-passed`), it will be re-prioritized over lower-priority items indefinitely.

The `mergeFailCount` circuit breaker (lines 2777-2784) eventually marks it stuck after `maxMergeRetries` (default 3) failures. But between failures, it gets priority again.

**Recommendation:** Consider adding a per-item "consecutive deferrals" counter that temporarily boosts priority after N consecutive deferrals (aging). Alternatively, accept the current behavior as a rare edge case with a natural circuit breaker (maxMergeRetries). Estimated effort for aging: ~20 LOC.

### 6. executeMerge has non-atomic compound operations -- SEVERITY: high
**Tag:** SIMPLIFY

`executeMerge()` (lines 1728-1972) performs a sequence of operations:
1. `deps.prMerge(...)` -- merge the PR
2. Set `mergeCommitSha` via `deps.getMergeCommitSha(...)`
3. Post audit trail comment
4. `this.transition(item, "merged")`
5. `deps.fetchOrigin(...)` + `deps.ffMerge(...)` -- pull main
6. Restack stacked dependents
7. Rebase sibling PRs
8. Sync stack navigation comments

If step 1 succeeds but step 5 throws, the item is already in `merged` state (step 4), but local main hasn't been updated. The restack logic (step 6) will use stale local main, potentially causing rebase failures.

More critically: if `prMerge` succeeds but the function throws before `transition(item, "merged")` (e.g., `getMergeCommitSha` throws), the item remains in `merging` state. The next poll cycle, `handleMerging` (lines 1285-1297) will detect `prState === "merged"` from the snapshot and transition correctly. So the state machine self-heals, but there's a gap cycle.

Steps 5-8 are wrapped in try/catch and marked "non-fatal", which is correct. The `fetchOrigin`/`ffMerge` failure case is handled. The restack failures fall back to worker messages.

**Recommendation:** Move `transition(item, "merged")` to immediately after `prMerge` succeeds (before `getMergeCommitSha`). This ensures the state is consistent even if later steps fail. The `getMergeCommitSha` call is already in a try/catch and falls back gracefully. Estimated effort: ~5 LOC (reorder).

### 7. transition() flag management: ci-failed resets reviewCompleted but ci-pending does not -- SEVERITY: low
**Tag:** KEEP

The `transition()` method (lines 660-700) resets `reviewCompleted = false` when entering `ci-failed` (lines 678-679), but not when entering `ci-pending`. The comment at line 676 explains this: "ci-pending is not included: the initial ci-pending has reviewCompleted=false by default, and regressions always go through ci-failed first (which resets it)."

This is correct for the normal flow: `ci-passed → ci-failed → ci-pending` (regression goes through ci-failed). But what about:
- `reviewing → ci-failed`: CI regresses during review. `handleReviewing` (line 1184) transitions to `ci-failed`, which resets `reviewCompleted`. Correct.
- `review-pending → ci-pending`: Worker pushes fix, CI restarts. `handleReviewPending` (line 1139) transitions to `ci-pending` with `reviewCompleted` still false (it was reset when entering ci-failed earlier). Correct.
- Direct external merge detected: `prState === "merged"` skips the review gate entirely. Correct -- merge already happened externally.

The one path that *could* be wrong: if the GitHub API reports `ci-pending` directly (skipping ci-failed), `reviewCompleted` would persist. But this only happens when CI hasn't run yet (initial push) or when CI reruns -- both legitimate "no regression" scenarios.

**Recommendation:** Keep as-is. The logic is correct and the comment explains the design decision well. The asymmetric reset is intentional and handles all real paths correctly.

### 8. Single flaky workerAlive=false reading: debounce is sound -- SEVERITY: low
**Tag:** KEEP

The three-layer timeout hierarchy in `handleImplementing` (lines 835-933):
1. **Heartbeat** (< 5 min freshness) → healthy, skip all timeout checks
2. **Process liveness** (workerAlive=true) → suppress launch timeout, hard cap at activityTimeoutMs
3. **Commit-based** → launchTimeoutMs or activityTimeoutMs

The `notAliveCount` debounce (lines 862-864) requires `NOT_ALIVE_THRESHOLD` (5) consecutive `workerAlive=false` polls before declaring dead. A single flaky listing returns an empty actions array, the worker continues.

The `lastAliveAt` baseline (lines 900-902) further protects against false positives. When workerAlive goes `true → false`, the timeout measures from `lastAliveAt` (when it was last confirmed alive), not from the poll where it first went false. This means a brief transient outage doesn't immediately trigger the timeout.

**However**, there's a gap: `lastAliveAt` is only set when `snap.workerAlive === true` (line 869). If a worker was **never** confirmed alive after entering `implementing` (e.g., it was alive during `launching` but the first `implementing` poll sees it as dead), `lastAliveAt` is undefined. The fallback is `new Date(item.lastTransition).getTime()` (line 902), which is the time the item entered `implementing`. This is correct -- the launch timeout measures from state entry.

**Recommendation:** Keep. The three-layer hierarchy is well-designed. Each layer has appropriate fallbacks. The `NOT_ALIVE_THRESHOLD=5` debounce prevents false positives from transient cmux listing failures. Cross-reference: Review 1 noted `notAliveCount` is not serialized in `DaemonStateItem` (Finding 1), meaning a daemon restart during debounce resets the count, but this is conservative (it delays stuck detection, doesn't cause false positives).

### 9. Stacked branch safety: stuck dep → dependent rollback -- SEVERITY: medium
**Tag:** KEEP

When a dependency goes stuck, the stuck dep handling (lines 796-813) performs:
- **Pre-WIP dependents** (ready/bootstrapping/launching): rolled back to `queued` with `baseBranch` cleared
- **WIP dependents** with active worker: sent a "pause" message

The concern: if a dependent already pushed commits against the old base branch (which is now stuck/abandoned), those commits are stacked on a branch that will never merge. When the dependency is eventually resolved and the dependent relaunches, it will start fresh from queued (baseBranch cleared), but the old worktree may still exist with orphaned commits.

This is handled correctly:
1. The "pause" message tells WIP workers to stop. They don't get rolled back because they may have significant work.
2. When the dependency is eventually resolved (manually unstuck), the dependent will be re-evaluated. If the dependency reaches `done`, the dependent's deps are met and it moves to `ready`.
3. The retry/relaunch will create a new worktree (or reuse the existing one if the worker cleans up).

**Remaining risk:** The orphaned branch `ninthwave/<dependent-id>` may have a PR open against `ninthwave/<stuck-dep-id>`. If the stuck dep's branch is deleted, the dependent's PR target becomes invalid. GitHub auto-retargets PRs when the base branch is deleted, but this creates a potentially confusing PR diff.

**Recommendation:** Keep the current behavior. Consider adding a step to `stuckOrRetry` that retargets dependent PRs to `main` when a dep goes permanently stuck (using `gh pr edit --base main`). This is a nice-to-have, not critical.

### 10. handleRepairing transitions to ci-pending on any CI status -- SEVERITY: low
**Tag:** SIMPLIFY

`handleRepairing()` (lines 1258-1283) checks:
```typescript
if (snap?.ciStatus === "pending" || snap?.ciStatus === "pass" || snap?.ciStatus === "fail") {
  this.transition(item, "ci-pending");
```

This transitions to `ci-pending` even when CI has already *passed*. The next cycle, `handlePrLifecycle` will detect `ciStatus === "pass"` and transition to `ci-passed`. This works correctly but adds a one-cycle delay for the pass case.

More concerning: it also transitions to `ci-pending` when CI has *failed*, meaning a repair worker that pushed code resulting in CI failure will have the item go `repairing → ci-pending → ci-failed` over two cycles rather than directly to `ci-failed`.

**Recommendation:** Consider transitioning directly to the appropriate CI state:
```typescript
if (snap?.ciStatus === "pass") this.transition(item, "ci-passed");
else if (snap?.ciStatus === "fail") this.transition(item, "ci-failed");
else if (snap?.ciStatus === "pending") this.transition(item, "ci-pending");
```
This would save one cycle for pass/fail cases. Low priority since one cycle (~10s) is inconsequential. Estimated effort: ~5 LOC.

### 11. handleMerging only handles merged state, not failures -- SEVERITY: medium
**Tag:** SIMPLIFY

`handleMerging()` (lines 1285-1297) only checks `prState === "merged"`:

```typescript
private handleMerging(item, snap): Action[] {
  const actions: Action[] = [];
  if (snap?.prState === "merged") {
    this.transition(item, "merged", snap?.eventTime);
    actions.push({ type: "clean", itemId: item.id });
  }
  return actions;
}
```

This means:
- If `prState === "closed"` (PR was manually closed without merging), the item stays in `merging` indefinitely.
- If CI fails while in `merging` state, the item stays in `merging`.
- If the merge was triggered but GitHub reports it as still "open" (race), the item waits for the next poll.

The first case (manual close) is a real concern. A human closing a PR should surface as `stuck` rather than silently staying in `merging` forever.

**Recommendation:** Add handling for `prState === "closed"`:
```typescript
if (snap?.prState === "closed") {
  this.transition(item, "stuck");
  item.failureReason = "merge-aborted: PR was closed without merging";
}
```
Estimated effort: ~5 LOC.

### 12. evaluateMerge: no-slot review workers silently queue without feedback -- SEVERITY: low
**Tag:** KEEP

In `evaluateMerge()` (lines 1458-1548), when `reviewCompleted` is false and no review slots are available (line 1496-1497):
```typescript
// else: no review slots available, stay in ci-passed until a slot opens
```

The item stays in `ci-passed` with no action. The next cycle repeats the same check. There's no mechanism to:
1. Tell the user that the item is waiting for a review slot
2. Distinguish "ci-passed, waiting for review slot" from "ci-passed, just arrived"
3. Detect if an item has been waiting for a review slot for an unreasonable time

**Recommendation:** Consider emitting an `onEvent` when a review slot is needed but unavailable, with a deduplicated event (e.g., once per item). This aids observability without adding state complexity. Low priority.

### 13. Duplicate comment on stale `reviewing` to `ci-passed` transition -- SEVERITY: low
**Tag:** KEEP

In `handleReviewing()` (lines 1198-1246), when the review verdict is "approve":
```typescript
item.reviewCompleted = true;
this.transition(item, "ci-passed", snap?.eventTime);
actions.push({ type: "clean-review", ... });
actions.push({ type: "post-review", ... });
actions.push({ type: "set-commit-status", ... });
actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
```

The `evaluateMerge` call (last line) now sees `reviewCompleted = true` and proceeds to merge evaluation. If the merge strategy is "auto", it will transition directly to `merging` and emit a merge action. This means in a single cycle: `reviewing → ci-passed → merging`. The ci-passed state is transient -- it exists for a fraction of a millisecond.

This is correct behavior (fast-path merge) but means the TUI will never display "CI Passed" for these items -- they flash from "Reviewing" to "Merging". This is fine for automation but slightly confusing for human observers.

**Recommendation:** Keep. The fast-path is desirable and the transient state is an implementation detail.

### 14. setState() bypasses transition() flag management -- SEVERITY: medium
**Tag:** SIMPLIFY

The public `setState()` method (lines 578-583) directly sets `item.state` and `item.lastTransition` without calling `transition()`:

```typescript
setState(id: string, state: OrchestratorItemState): void {
  const item = this.items.get(id);
  if (!item) return;
  item.state = state;
  item.lastTransition = new Date().toISOString();
}
```

This bypasses all the flag management in `transition()`:
- No `rebaseRequested` reset
- No `reviewCompleted` reset on ci-failed
- No `ciFailureNotified` reset on recovery
- No `failureReason` clearing
- No `startedAt`/`endedAt` telemetry
- No `onTransition` callback emission
- No latency tracking

A grep for `setState(` usage would reveal if this is called from external code (e.g., the daemon event loop for state restoration). If it's used for hydrating state from disk (daemon restart), bypassing flags is intentional. If it's used for runtime transitions, it's a bug factory.

**Recommendation:** Either (a) rename to `hydrateState()` to signal its intended use (state restoration, not runtime transitions), or (b) merge its logic into `transition()` with a `skipFlags` parameter. Estimated effort: ~10 LOC.

### 15. launching state has no timeout -- SEVERITY: low
**Tag:** KEEP

The `launching` state handler (lines 724-738) only checks for `workerAlive` status:
- If alive → transition to implementing
- If dead (debounced) → stuck/retry
- Otherwise → wait

There's no timeout for the launching state itself. If the worker session is created but never registers as alive or dead (cmux hangs, workspace ref is wrong), the item stays in `launching` indefinitely.

In practice, the poll layer will report `workerAlive=undefined` (no snapshot data) and the item will sit in launching. The `NOT_ALIVE_THRESHOLD` debounce doesn't help because `workerAlive` is `undefined`, not `false`.

**Recommendation:** Add a launching timeout (e.g., 5 minutes). If the worker hasn't been detected as alive within that window, treat it as a launch failure. This is low priority because the daemon poll layer usually reports `workerAlive` within 1-2 cycles. Estimated effort: ~10 LOC.

## Theme A: Feature Necessity

### State-by-state assessment

| State | Tag | Rationale |
|---|---|---|
| `queued` | **KEEP** | Essential. Dependency waiting state. Every item starts here. |
| `ready` | **KEEP** | Essential. WIP gating state. Items wait here for a slot. |
| `bootstrapping` | **KEEP** | Cross-repo only. If cross-repo is stripped, this state can go. Currently required for `bootstrap: true` items that need repo cloning. |
| `launching` | **KEEP** | Essential. Transition state between ready and implementing. Captures launch failures. |
| `implementing` | **KEEP** | Essential. Core worker-active state with heartbeat/timeout logic. |
| `pr-open` | **SIMPLIFY** | Transient. `handlePrLifecycle` handles `pr-open`, `ci-pending`, `ci-passed`, and `ci-failed` uniformly. In `handleImplementing()` (lines 847-857), when a PR is detected, the item transitions to `pr-open` and immediately falls through to `handlePrLifecycle`, which may transition to `ci-pending`/`ci-passed`/`ci-failed` in the same cycle. `pr-open` exists for at most one cycle before CI status is resolved. Could be collapsed into `ci-pending` (a PR without CI status is effectively "CI pending"). |
| `ci-pending` | **KEEP** | Essential. CI running state. |
| `ci-passed` | **KEEP** | Essential. Merge-ready state. Decision point for review gate and merge strategy. |
| `ci-failed` | **KEEP** | Essential. CI failure state with notification and retry logic. |
| `repairing` | **KEEP** | Required for daemon-rebase fallback. When daemon-side rebase fails and no live worker can resolve conflicts, a repair worker is launched. Without this state, conflicting PRs would go stuck immediately. |
| `review-pending` | **QUESTIONABLE** | Serves two purposes: (1) waiting for human review in manual merge mode, (2) waiting for implementer to address AI review feedback. The dual purpose is slightly confusing. However, collapsing it into ci-passed would lose the semantic signal "this item needs review attention." |
| `reviewing` | **KEEP** | Required for AI review worker lifecycle. Tracks active review sessions. |
| `merging` | **KEEP** | Essential. Tracks in-flight merge operation. |
| `merged` | **SIMPLIFY** | Transient. In `transitionItem` (lines 769-775), `merged` immediately transitions to `verifying` (if enabled) or `done`. Exists for at most one cycle. Could be collapsed: `executeMerge` could set `mergeCommitSha` and transition directly to `verifying`/`done`. However, `merged` provides a clean audit trail in the transition log. |
| `verifying` | **KEEP** | Required for post-merge CI verification. Catches "your PR was green but broke main" scenarios. Can be disabled via `verifyMain: false`. |
| `verify-failed` | **KEEP** | Required for verifier worker circuit breaker. Tracks post-merge CI failure with retry counting. |
| `repairing-main` | **KEEP** | Required for verifier worker lifecycle. Analogous to `repairing` but for post-merge. |
| `done` | **KEEP** | Terminal success state. |
| `stuck` | **KEEP** | Terminal failure state. |

### Is bootstrapping used outside cross-repo?

`needsBootstrap()` (lines 2654-2661) checks `item.workItem.bootstrap`, `repoAlias`, and `resolvedRepoRoot`. The `bootstrap` field is only set by cross-repo work items. Hub-local items never enter `bootstrapping` -- they go directly from `ready` to `launching`. If cross-repo support is stripped, `bootstrapping` can be removed.

### Is verifying actually doing verification?

Yes. `handleVerifying()` (lines 1303-1322) polls `mergeCommitCIStatus` from the snapshot. This is a real CI check on the merge commit SHA on main, not a passthrough. The snapshot's `mergeCommitCIStatus` is populated by `deps.checkCommitCI(repoRoot, sha)`. When CI fails, it transitions to `verify-failed`, which can launch a verifier worker. This is a meaningful state.

### Are stacked launches being used?

Yes. Stacking is enabled by default (`enableStacking: true`, line 139). The `canStackLaunch()` method (lines 2541-2575) is called every cycle for queued items. The restack logic in `executeMerge` (lines 1830-1889) handles post-merge cleanup. The `STACKABLE_STATES` set is conservative (only ci-passed, review-pending, merging), limiting risk. This is actively used in the dogfooding workflow (this very PR is stacked on H-ER-1).

### Is the review worker flow serving users?

The review flow (ci-passed → reviewing → ci-passed/review-pending) is actively wired. `evaluateMerge()` gates on `reviewCompleted` (line 1467) and launches review workers when slots are available. The `maxReviewRounds` circuit breaker (line 1471) prevents infinite review loops. The commit status integration (lines 1486-1495) provides visibility. This is a real, used feature.

## Theme B: Complexity Reduction

### Can pr-open and ci-pending be collapsed?

Yes. `pr-open` is a transient state that exists for at most one cycle. When a PR is detected in `handleImplementing()` (line 847-857), the code transitions to `pr-open` then immediately calls `handlePrLifecycle()`, which resolves the CI status and may transition to `ci-pending`/`ci-passed`/`ci-failed` in the same call.

The only distinction between `pr-open` and `ci-pending` is that `pr-open` represents "PR exists but we haven't checked CI yet." In practice, the GitHub poll always includes CI status alongside PR state. The separate state adds a row to the state table without providing behavioral value.

**Estimated savings:** ~10 LOC (remove pr-open from the state union, WIP_STATES, status display, and comment relay states). `handleImplementing` would transition directly to `ci-pending`.

**Trade-off:** `pr-open` provides a cleaner audit trail ("PR was created" as a distinct event). This is minor since the transition log already captures `implementing → pr-open → ci-pending` vs `implementing → ci-pending`.

### Is the three-layer timeout hierarchy necessary?

The three layers (heartbeat, process liveness, commit-based) address distinct failure modes:
1. **Heartbeat**: Worker is actively running and reporting progress. Cheapest signal.
2. **Process liveness**: Worker process is alive but not heartbeating (startup gap, or broken heartbeat). Suppresses the launch timeout.
3. **Commit-based**: Final backstop. Worker may be alive but completely stalled.

A simpler two-layer model (heartbeat + commit-based) would work if heartbeating were reliable from the first second of launch. The `process liveness` layer exists specifically to handle the ~30-60 second gap between worker launch and first heartbeat. Without it, workers would need to heartbeat within `launchTimeoutMs` or be killed.

**Verdict:** The three layers are justified. The startup gap is real (workers take 30-60s to load, read context, and send their first heartbeat). Removing layer 2 would require either (a) increasing `launchTimeoutMs` significantly (masking real launch failures) or (b) requiring instant heartbeating (unreliable). Keep.

### Can execute* methods be simplified or deduplicated?

Several execute methods share a pattern:
1. Check if a dependency function exists
2. Get repo root (with cross-repo fallback)
3. Try the operation
4. Update item state on success/failure

A generic `executeWithDep<T>(item, depFn, mapResult)` could deduplicate `executeLaunchRepair`, `executeLaunchReview`, `executeLaunchVerifier`, and their clean counterparts. Each follows:
```typescript
if (!deps.someFn) return { success: false, error: "not available" };
try { const result = deps.someFn(...); item.someRef = result.ref; return { success: true }; }
catch { return { success: false, error: msg }; }
```

**Estimated savings:** ~60 LOC across 6 methods. The abstraction would make the pattern explicit.

**Trade-off:** Each method has slight variations (different error messages, different fields to update, different fallback behavior). A generic wrapper would either need many parameters or lose the specific error messages. The current explicit approach is verbose but clear.

**Verdict:** SIMPLIFY for the clean methods (cleanRepair, cleanReview, cleanVerifier are nearly identical). KEEP for the launch methods (different enough to warrant separate implementations).

### Can the Orchestrator class be decomposed?

At 2,662 LOC in a single file, the class is large but has a clear internal structure:
- **Types and config** (lines 1-424): interfaces, constants, defaults
- **State machine** (lines 511-933): Orchestrator class, processTransitions, transitionItem, handleImplementing
- **PR lifecycle** (lines 955-1161): handlePrLifecycle, handleReviewPending
- **Review/repair/verify** (lines 1162-1389): handleReviewing, handleRepairing, handleMerging, handleVerifying, handleVerifyFailed, handleRepairingMain
- **Comment processing** (lines 1391-1455): processComments
- **Merge evaluation** (lines 1457-1548): evaluateMerge
- **Action execution** (lines 1550-2500): all execute* methods
- **Helpers** (lines 2502-2662): prioritizeMergeActions, canStackLaunch, buildStackChain, launchReadyItems, needsBootstrap

The most natural decomposition:
1. **Extract types** to a separate file (e.g., `core/orchestrator-types.ts`). The type definitions (OrchestratorItem, OrchestratorConfig, ItemSnapshot, PollSnapshot, Action, ActionType, OrchestratorDeps, etc.) are ~375 LOC.
2. **Extract action execution** to `core/orchestrator-actions.ts`. The execute* methods are ~950 LOC and have a clear boundary (they take an item + deps and return ActionResult).

This would split the file roughly: ~375 LOC types, ~1,350 LOC state machine, ~950 LOC execution. Each file would be independently comprehensible.

**Trade-off:** The "pure state machine" property depends on `processTransitions` not calling execute methods. This is already enforced by the method signatures (processTransitions returns actions, executeAction takes actions). The decomposition preserves this property.

**Verdict:** SIMPLIFY. Extract types and execute methods. Keep the core state machine in `orchestrator.ts`. The file is manageable now but will grow as new states/actions are added. **Estimated savings: 0 LOC (same code, different files), but significant cognitive overhead reduction.**

## Recommendations

**Priority 1 (High -- correctness risk):**
1. **Reset `lastCommitTime` in `stuckOrRetry()`** (Finding 2). Stale commit time from a previous attempt can cause the retried worker to immediately timeout. ~3 LOC fix.
2. **Reorder `executeMerge` to transition immediately after prMerge** (Finding 6). Ensures state consistency when later steps fail. ~5 LOC reorder.
3. **Handle `prState === "closed"` in `handleMerging`** (Finding 11). Prevents items stuck in `merging` state when PRs are manually closed. ~5 LOC.

**Priority 2 (Medium -- code quality):**
4. **Update ARCHITECTURE.md** with all 19 states, correct STACKABLE_STATES, and correct WIP states (Finding 1). ~30 LOC in docs.
5. **Rename `setState` to `hydrateState`** or merge with `transition()` (Finding 14). Prevents accidental use for runtime transitions. ~10 LOC.
6. **Consider memory-aware combined WIP limit** (Finding 3). Either include `reviewing` in WIP_STATES or adjust `calculateMemoryWipLimit`. Product decision.

**Priority 3 (Low -- simplification):**
7. **Collapse `pr-open` into `ci-pending`** (Theme B). ~10 LOC savings, removes a transient-only state.
8. **Extract types and execute methods** into separate files (Theme B). 0 LOC net, cognitive overhead reduction.
9. **Deduplicate clean methods** (cleanRepair, cleanReview, cleanVerifier) (Theme B). ~30 LOC savings.
10. **Add launching state timeout** (Finding 15). ~10 LOC.

**Cross-references to Review 1:**
- Review 1 Finding 1 (OrchestratorItem/DaemonStateItem divergence): `notAliveCount` is not serialized, which is conservative -- daemon restart resets debounce counter, delaying stuck detection rather than causing false positives (see Finding 8 above).
- Review 1 Finding 7 (duplicate PRIORITY_RANK): Confirmed used in `prioritizeMergeActions()` (line 2518). Should import `PRIORITY_NUM` from types.ts instead.
- Review 1 Finding 12 (30+ optional fields): Confirmed the flat-optional approach works because `transitionItem` exhaustively matches states and `transition()` manages flags correctly. The main risk is `setState()` bypassing flag management (Finding 14 above).
