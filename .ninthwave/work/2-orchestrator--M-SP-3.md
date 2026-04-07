# Feat: Fast-path CI failure resume for parked items (M-SP-3)

**Priority:** Medium
**Source:** Session parking plan (2026-04-07)
**Depends on:** H-SP-2
**Domain:** orchestrator
**Lineage:** 9714996a-61a3-4636-8c44-c26b205c47b6

Optimization: when CI fails on a parked review-pending item, skip the normal CI failure notification path (which would discover no workspace and relaunch after an intermediate state) and go directly to `respawnCiFixWorker()`. In `handleReviewPending`, capture `wasParked` before the transition to `ci-failed` (since `transition()` clears `sessionParked`), then call `respawnCiFixWorker()` directly if `wasParked=true`. This saves one poll cycle compared to the fallback path through `handleCiFailed` -> `executeNotifyCiFailure` -> no-workspace relaunch.

**Test plan:**
- Test: CI fails on parked item -- assert direct transition to `ready` via `respawnCiFixWorker` (not through `ci-failed` notification path)
- Test: CI fails on non-parked review-pending item -- assert existing behavior unchanged (notification sent to live worker)
- Test: `needsCiFix` is set on the respawned item so launch forces a worker even with existing PR

Acceptance: Parked items with CI failure skip the ack timeout and relaunch immediately via `respawnCiFixWorker`. Non-parked review-pending items retain existing CI failure behavior. All tests pass.

Key files: `core/orchestrator.ts`
