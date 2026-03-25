# Stale worktree cleanup should be handled by the orchestrator/daemon

**Observed:** 2026-03-25, grind cycle 1 startup

## What happened

After a previous aborted orchestration run, 6 worktrees and 7 branches were left behind in stale "in-progress" state. All worktrees had zero commits beyond main — no actual work was done. The `ninthwave clean` command only cleaned 0 worktrees (didn't detect them as stale). The grind loop supervisor (me) had to manually:

1. Check each worktree for commits (`git log main..HEAD`)
2. Force-remove each worktree (`git worktree remove --force`)
3. Delete each branch (`git branch -D`)
4. Prune worktree references
5. Re-reconcile

This took ~3 minutes of back-and-forth before the actual work could start.

## Expected behavior

The orchestrator or `ninthwave reconcile` should detect and clean stale worktrees at startup:
- If a worktree exists for an item but has no commits beyond main and no open PR, it's stale
- `ninthwave reconcile` should clean these automatically (or `ninthwave clean` should detect them)
- The `clean` command should recognize worktrees with no delta as safe to remove without confirmation

## Impact

Blocks the grind loop from starting autonomously. The daemon should handle this without human intervention — the whole point is tight feedback loops.
