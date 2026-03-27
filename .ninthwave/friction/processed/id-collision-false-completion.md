# Friction: Orchestrator falsely completes items by matching old merged PRs

**Observed:** 2026-03-27
**Project:** ninthwave (ninthwave-sh/ninthwave)
**Severity:** High
**Component:** orchestrator state detection / worker lifecycle

## What happened

H-ORC-1, H-ORC-2, and M-ORC-3 were reused TODO IDs — the same IDs had been used in a previous cycle for different work (different titles, different PRs). The orchestrator launched workers for all 3, but the workers detected existing merged PRs on the `todo/H-ORC-*` and `todo/M-ORC-3` branches and immediately exited, marking the items as "merged" within 15-50 seconds.

The orchestrator then cleaned up worktrees and marked all 3 as "done". But reconcile correctly identified the title mismatch and refused to remove the TODO files. The actual work was never implemented.

## Log evidence

```
18:38:40 launch H-ORC-2 (warning: branch has 1 merged PR from previous cycle)
18:39:31 transition H-ORC-2 implementing → merged  (~50 seconds, no real work done)
18:40:01 transition H-ORC-2 merged → done

18:39:06 launch M-ORC-3 (warning: branch has 1 merged PR from previous cycle)
18:39:31 transition M-ORC-3 implementing → merged  (~25 seconds, no real work done)
18:40:01 transition M-ORC-3 merged → done

18:40:13 launch H-ORC-1 (warning: branch has 1 merged PR from previous cycle)
18:40:35 transition H-ORC-1 implementing → merged  (~22 seconds, no real work done)
18:41:05 transition H-ORC-1 merged → done
```

## Expected behavior

When a TODO ID has old merged PRs with different titles, the orchestrator should:
1. Delete the old branch before launching the worker (fresh start)
2. OR have the worker create a fresh branch with a suffix (e.g., `todo/H-ORC-1-v2`)
3. OR use title matching in the worker's PR detection to avoid matching stale PRs

## Suggested fix

Before launching a worker, if the branch already exists and has a merged PR with a different title than the current TODO, delete the branch and create fresh. The warning is already emitted ("Title comparison will prevent false completion") but no action is taken to prevent the false match.
