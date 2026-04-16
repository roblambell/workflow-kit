# Refactor: Switch to state-based inflight counting (H-IS-3)

**Priority:** High
**Source:** docs/intake-scheduling-design.md
**Depends on:** H-IS-2
**Domain:** intake-scheduling
**Lineage:** 7d8ae8b5-aea2-4252-9269-819ffa86cd96

Change `activeItemCount` (renamed from `activeSessionCount` in H-IS-2) from workspace-ref-based counting to state-based counting using `ACTIVE_SESSION_STATES`. The current approach counts items that have any workspace reference (`workspaceRef || reviewWorkspaceRef || rebaserWorkspaceRef || fixForwardWorkspaceRef`), which misses items in active states whose worker has died -- those items are still commitments the orchestrator will recover, so they should count against the inflight limit.

Before (workspace-ref counting):
```
get activeItemCount(): number {
  return this.getAllItems().filter(item =>
    !!(item.workspaceRef || item.reviewWorkspaceRef || ...)).length;
}
```

After (state-based counting):
```
get activeItemCount(): number {
  return this.getAllItems().filter(item =>
    ACTIVE_SESSION_STATES.has(item.state)).length;
}
```

`ACTIVE_SESSION_STATES` already exists in `core/orchestrator-types.ts` and contains: launching, implementing, ci-pending, ci-passed, ci-failed, rebasing, reviewing, review-pending, merging.

**Test plan:**
- Update `activeItemCount` tests in `orchestrator-unit.test.ts` to verify state-based counting
- Add test: item in "implementing" state with no workspace ref (dead worker) should still count
- Add test: item in "queued" or "ready" state should NOT count even if it has a stale workspace ref
- Verify launch gating tests still pass -- items at capacity should block new launches regardless of workspace presence
- Edge case: item in "review-pending" state (manual mode, parked) should count toward inflight limit

Acceptance: `activeItemCount` counts items by `ACTIVE_SESSION_STATES` membership, not workspace references. An item in an active state with a dead worker (no workspace ref) is counted. An item outside active states with a stale workspace ref is not counted. `bun run test` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator-unit.test.ts`, `test/orchestrator.test.ts`
