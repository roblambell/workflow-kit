# Fix: Clean external worktrees blocking branch creation (H-WR-2)

**Priority:** High
**Source:** Friction log: external-worktree-branch-collision.md (2026-03-27)
**Depends on:** None
**Domain:** daemon

When `launchSingleItem` tries to create a branch that is checked out in an external worktree (e.g., `.claude/worktrees/` from a prior agent session), `git branch -D` fails because git refuses to delete a checked-out branch. The error is caught and silently warned (start.ts:489-498), then execution continues to `createWorktree` which fails with "fatal: a branch named 'todo/X' already exists". Fix: when `deleteBranch` fails, call `findWorktreeForBranch` to locate the external worktree, remove it with `removeWorktree --force`, then retry the branch deletion. The helper `findWorktreeForBranch` already exists in git.ts (uses `git worktree list --porcelain`) but is only called in the open-PR detection path (start.ts:456), not in the branch deletion fallback path.

**Test plan:**
- Test `launchSingleItem` when branch exists in external worktree: verify external worktree is removed and branch deletion succeeds
- Test fallback when external worktree removal fails: verify clear error message instead of silent warning followed by cryptic failure
- Test `cleanStaleBranchForReuse` still works correctly when no external worktrees exist (no regression)
- Edge case: branch checked out in BOTH orchestrator worktree AND external worktree

Acceptance: When a branch is checked out in an external worktree (e.g., `.claude/worktrees/`), the orchestrator detects it, removes the external worktree, and successfully deletes/recreates the branch. No silent failures -- if external worktree removal fails, the error propagates clearly. Existing tests pass.

Key files: `core/commands/start.ts` (launchSingleItem lines 488-498, findWorktreeForBranch call at 456-468), `core/git.ts` (findWorktreeForBranch lines 111-129, deleteBranch lines 100-102)
