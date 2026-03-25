# Feat: Post-merge restacking and stuck dep handling (H-STK-5)

**Priority:** High
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** H-STK-3
**Domain:** branch-stacking

Implement daemon-managed restacking after a dependency merges, and pause/resume for stuck deps.

**Post-merge restacking** in `executeMerge()`:
- After a dep merges, iterate all in-flight items that depend on it
- For stacked items (`other.baseBranch` is set): use `rebaseOnto(worktreePath, "main", "todo/depId", "todo/otherId")` to replay only the dependent's commits onto main (squash-merge safe via `--onto`)
- On success: `git push --force-with-lease`, clear `other.baseBranch` (no longer stacked)
- On conflict: send worker a message with the manual rebase command
- Critical: `continue` past the existing rebase message loop for stacked items — they should NOT receive the generic "rebase onto main" message (the daemon handles restacking)
- Non-stacked items get existing behavior unchanged

**Stuck dep pause/resume** in `transitionItem()`:
- When a dep transitions to `stuck`: scan for stacked dependents, send pause message
- When a dep recovers from `ci-failed` to `ci-pending`: scan for stacked dependents, send rebase-and-resume message

**Test plan:**
- Test `executeMerge()` with stacked dep: verify `rebaseOnto()` is called with correct args and branch is force-pushed
- Test `executeMerge()` with stacked dep conflict: verify worker receives conflict message with manual rebase instructions
- Test `executeMerge()` with non-stacked dep: verify existing rebase behavior is unchanged
- Test stuck dep: when dep goes stuck, verify pause message is sent to stacked dependent (not to non-stacked items)
- Test dep recovery: when dep transitions from ci-failed to ci-pending, verify resume message sent to stacked dependent

Acceptance: After a dep squash-merges, stacked dependents are rebased with `--onto` (no duplicate commits) and force-pushed. Stacked items skip the generic rebase message. Stuck deps trigger pause; recovery triggers resume. Non-stacked behavior unchanged. Inject `rebaseOnto` as a dependency for testability.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
