# Fix: Review worker off-mode reuses implementer worktree (H-WR-2)

**Priority:** High
**Source:** Dogfooding friction 2026-03-28 -- review workers in off-mode detach main repo HEAD via git commands in plain directory
**Depends on:** None
**Domain:** worker-reliability

In off-mode (comment-only review), `launchReviewWorker` creates a plain directory at `.worktrees/review-{itemId}` instead of a git worktree. Since this directory is inside the main repo, any git commands the reviewer runs (e.g., `gh pr checkout`, `git fetch`) affect the main checkout, causing detached HEAD. The fix: pass the implementer's existing worktree path to the review worker in off-mode so it runs in the correct git context.

**Changes:**

1. `launchReviewWorker` in off-mode: accept and use the implementer's worktree path instead of creating a plain directory with `mkdirSync`. The worktree already has the PR branch checked out and is isolated from the main repo.
2. Update the orchestrator's `launchReview` call sites to pass the implementer's worktree path (available from the orchestrator's item state).
3. Update the review cleanup path -- in off-mode there is no review-specific worktree to clean up since the reviewer shares the implementer's worktree.

**Test plan:**
- Add unit test: off-mode `launchReviewWorker` uses the provided worktree path, does not call `mkdirSync` for a new directory
- Add unit test: off-mode review cleanup does not attempt to remove the implementer's worktree
- Run `bun test test/` to verify no regressions

Acceptance: Review workers in off-mode run inside the implementer's worktree, not a plain directory under `.worktrees/`. No git commands from off-mode review workers affect the main repo checkout. `bun test test/` passes.

Key files: `core/commands/launch.ts:684`, `core/commands/orchestrate.ts`, `core/orchestrator.ts`
