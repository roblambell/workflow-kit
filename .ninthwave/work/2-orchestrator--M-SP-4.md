# Feat: TUI parked indicator for review-pending items (M-SP-4)

**Priority:** Medium
**Source:** Session parking plan (2026-04-07)
**Depends on:** H-SP-2
**Domain:** orchestrator
**Lineage:** 194ee279-51c0-4668-9f49-0b1a446ebb71

Add a visual indicator in the status TUI for parked review-pending items. Extend the existing `manualReviewMarker()` function in `status-render.ts` (or the state label rendering) to show "(parked)" or a distinct marker when `sessionParked=true`. This gives operators visibility into which items have released their worker session vs which are still holding an active session. The `StatusItem` interface may need a `sessionParked` field propagated from the orchestrator item.

**Test plan:**
- Test: parked review-pending item renders with "(parked)" indicator in status output
- Test: non-parked review-pending item renders without the indicator (existing behavior unchanged)
- Test: items in other states never show the parked indicator

Acceptance: `nw` TUI and `ninthwave status` output distinguish parked review-pending items from active ones. Non-parked items and other states are unaffected. Existing status rendering tests pass.

Key files: `core/status-render.ts`
