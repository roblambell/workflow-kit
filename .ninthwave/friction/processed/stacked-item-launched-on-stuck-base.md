# Friction: Stacked item launched even though base item is stuck

**Observed:** 2026-03-27
**Project:** strait (ninthwave-sh/strait)
**Severity:** High
**Component:** orchestrator dependency/stacking logic

## What happened

L-V2-5 depends on M-V2-4. When M-V2-4 moved to `merging` state at 18:02, the orchestrator immediately transitioned L-V2-5 from `queued` to `ready` with `stacked: true, baseBranch: "ninthwave/M-V2-4"`. Then M-V2-4's merge failed 3 times and was marked stuck at 18:03. Despite this, L-V2-5 was launched at 18:03 stacked on the stuck M-V2-4 branch.

The result: L-V2-5's worker implemented the feature on top of a stale, conflicting base branch. The PR (#28) is CONFLICTING and CI never ran. The entire L-V2-5 worker session was wasted.

## Expected behavior

Two fixes needed:
1. **Don't transition dependents to ready until the base actually merges.** The `merging` state is not terminal — the merge can fail. Only transition to `ready` after the base reaches `done`.
2. **If a base item transitions to stuck, cancel or re-queue any stacked dependents.** L-V2-5 should have been moved back to `queued` when M-V2-4 went stuck.

## Log evidence

```
18:02:38 transition M-V2-4 ci-pending → merging
18:02:38 transition L-V2-5 queued → ready  stacked:true baseBranch:"ninthwave/M-V2-4"
18:03:07 action_result merge M-V2-4 success:false "Merge failed 3 times, marking stuck"
18:03:19 transition L-V2-5 ready → launching  (launched anyway)
```

## Suggested fix

Only transition stacked dependents to `ready` when the base reaches `done` (not `merging`). Add a state rollback: if a base item goes `stuck`, any dependent items in `ready` or `launching` should revert to `queued`.
