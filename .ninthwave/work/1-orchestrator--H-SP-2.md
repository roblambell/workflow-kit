# Feat: Park sessions on review-pending and adjust WIP counting (H-SP-2)

**Priority:** High
**Source:** Session parking plan (2026-04-07)
**Depends on:** H-SP-1
**Domain:** orchestrator
**Lineage:** 77bfe858-2a06-4d34-89d6-b4dbcd3b7777

Core session parking behavior. In `evaluateMerge()`, when transitioning to `review-pending` with `reviewCompleted=true` and `reviewDecision !== CHANGES_REQUESTED`, set `sessionParked=true` and emit a `workspace-close` action to kill the idle worker. Modify `activeSessionCount` to exclude items where `sessionParked=true` so parked items don't consume WIP slots. Add a `TRANSITION_SIDE_EFFECTS` or `transition()` clearing rule so `sessionParked` resets when leaving `review-pending`. Add resume logic in `handleReviewPending`: when `sessionParked=true` and `reviewDecision=CHANGES_REQUESTED` is detected, reset `reviewCompleted=false` and call `respawnCiFixWorker()` to relaunch a worker.

Key design rules:
- Do NOT park when `reviewCompleted=false` (worker addressing AI review feedback)
- Do NOT park when `CHANGES_REQUESTED` is the trigger for entering review-pending (worker needs to address human feedback)
- DO park when `mergeStrategy=manual` or `requiresManualReview=true` with `reviewCompleted=true`
- On strategy change to auto while parked, `forceReviewPendingReevaluation` re-runs `evaluateMerge` which transitions to merging -- no worker needed for that

**Test plan:**
- Test: manual strategy item reaches review-pending with reviewCompleted=true -- assert `sessionParked=true` and `workspace-close` action emitted
- Test: `activeSessionCount` excludes parked items, `availableSessionSlots` increases by 1
- Test: queued item can launch after another item is parked (WIP slot freed)
- Test: item entering review-pending with `reviewCompleted=false` (AI request-changes) -- assert NOT parked
- Test: item entering review-pending due to `CHANGES_REQUESTED` -- assert NOT parked
- Test: parked item with `CHANGES_REQUESTED` detected -- assert `respawnCiFixWorker` is called, `reviewCompleted` reset to false
- Test: strategy change to auto while parked -- assert evaluateMerge transitions to merging
- Test: external merge on parked item -- clean action works (no workspace to close)
- Test: `sessionParked` cleared on transition out of review-pending

Acceptance: Parked review-pending items do not count toward WIP limit. New items launch in freed slots. Parked items resume on human CHANGES_REQUESTED. Strategy changes and external merges work correctly on parked items. All existing orchestrator tests pass.

Key files: `core/orchestrator.ts`
