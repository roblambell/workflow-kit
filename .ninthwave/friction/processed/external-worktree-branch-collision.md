# External worktree branch collision causes launch failure

**Date:** 2026-03-27
**Severity:** High — blocks items from launching, requires manual cleanup
**Observed during:** `/work` orchestration with stale `.claude/worktrees/` from prior agent sessions

## Symptoms

- H-NTF-1 and H-TUI-7 both failed with `launch-failed: git worktree failed (exit 255): fatal: a branch named 'ninthwave/H-NTF-1' already exists`
- H-NTF-1 had already completed work and opened PR #271 in a prior session, but the orchestrator tried to launch fresh anyway
- Three stale worktrees in `.claude/worktrees/` held the branches, preventing deletion

## Root causes

1. **Silent branch deletion failure.** `start.ts:441-445` catches and ignores the error when `git branch -D` fails. But `git branch -D` refuses to delete a branch checked out in *any* worktree — the ignore means the code proceeds as if the branch was deleted.

2. **No awareness of external worktrees.** The orchestrator only checks `.worktrees/` for existing worktrees. It never calls `git worktree list` to discover worktrees created by other tools (e.g., Claude Code agents in `.claude/worktrees/`).

3. **No open PR detection at launch time.** `cleanStaleBranchForReuse` only checks for *merged* PRs. If an open PR already exists for the branch (from a prior session), the orchestrator should detect it and transition to CI-tracking state instead of launching fresh.

## Fix needed

In `launchSingleItem` (start.ts), when `deleteBranch` fails:
- Use `git worktree list` to find which worktree holds the branch
- Remove the external worktree, then retry deletion
- Before launching at all, check for existing open PRs and skip launch if one exists
