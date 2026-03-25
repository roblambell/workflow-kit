# Fix: Auto-clean stale worktrees with zero commits on reconcile (M-ORC-1)

**Priority:** Medium
**Source:** Friction log (grind cycle 1, 2026-03-25)
**Depends on:** (none)
**Domain:** orchestrator

When a previous orchestration run is aborted, worktrees and branches are left behind in stale "in-progress" state. The `ninthwave clean` command and `ninthwave reconcile` don't detect these as stale, forcing manual cleanup before the next run.

## What to fix

Enhance `ninthwave reconcile` (or `ninthwave clean`) to detect and remove stale worktrees:

1. **Detection:** For each worktree matching `todo-*` pattern, check if it has any commits beyond main (`git log main..HEAD` returns empty). If zero commits AND no open PR for that branch, it's stale.
2. **Cleanup:** Remove the worktree (`git worktree remove --force`), delete the branch (`git branch -D`), and prune worktree references.
3. **Reporting:** Log which worktrees were cleaned so the user knows what happened.

This should run automatically at the start of `reconcile` so the grind loop can start autonomously without manual intervention.

## Acceptance

- `ninthwave reconcile` detects worktrees with zero commits beyond main and no open PR
- Stale worktrees are removed automatically with a log message
- Items previously marked in-progress (due to branch existence) revert to open/ready
- Test: create a worktree with no commits, run reconcile, verify it's cleaned up

## Key files

- `core/commands/reconcile.ts` — main reconcile logic
- `core/commands/clean.ts` — existing clean command
- `core/worktree.ts` — worktree utilities (if exists)
