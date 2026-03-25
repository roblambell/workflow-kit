# Feat: Stacked launch execution (H-STK-4)

**Priority:** High
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** H-STK-3
**Domain:** branch-stacking

Implement the worker-side stacked launch: when the orchestrator passes `baseBranch`, the worker launches on the dependency's branch and creates a PR against it.

Changes to `core/commands/start.ts`:
1. Add `baseBranch?: string` to `launchSingleItem()` options
2. When `baseBranch` is set: fetch the dep branch (not main), create worktree from the dep branch using `createWorktree(repo, path, branchName, baseBranch)`, skip the main fetch/ff-merge
3. Add `BASE_BRANCH: todo/X` to the system prompt when stacking

Changes to `core/commands/orchestrate.ts`:
- Thread `action.baseBranch` from the orchestrator's launch action through to `deps.launchSingleItem()`

Changes to `agents/todo-worker.md`:
- Add instructions: when `BASE_BRANCH` is set, use `gh pr create --base $BASE_BRANCH` to create the PR against the dependency branch instead of main. This gives reviewers clean diffs showing only the dependent's changes.

**Test plan:**
- Test `launchSingleItem()` with `baseBranch`: verify `createWorktree` is called with the dep branch as startPoint (not HEAD)
- Test `launchSingleItem()` with `baseBranch`: verify `BASE_BRANCH` appears in the system prompt written to the temp file
- Test `launchSingleItem()` with `baseBranch`: verify main fetch/ff-merge is skipped, dep branch is fetched instead

Acceptance: Stacked workers launch from the dependency branch. System prompt includes `BASE_BRANCH`. Worker prompt instructs `--base` flag usage. Non-stacked launches (no baseBranch) are unchanged. `orchestrate.ts` correctly threads baseBranch from action to deps call.

Key files: `core/commands/start.ts`, `core/commands/orchestrate.ts`, `agents/todo-worker.md`, `test/start.test.ts`
