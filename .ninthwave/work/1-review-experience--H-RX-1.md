# Fix: Multi-round review loop -- fix handleReviewPending CI detection (H-RX-1)

**Priority:** High
**Source:** CEO + Eng review 2026-03-28
**Depends on:** None
**Domain:** review-experience

`handleReviewPending` (orchestrator.ts:1073-1092) ignores CI status changes. When a reviewer requests changes and the implementer pushes fixes, the item stays stuck in `review-pending` forever. Fix by adding CI handling: ciStatus pending -> ci-pending, fail -> ci-failed + notify, pass -> ci-passed + evaluateMerge (re-launches review since reviewCompleted is still false), isMergeable false -> daemon-rebase. ~15 lines of new code following the existing `handlePrLifecycle` patterns.

**Test plan:**
- Add unit tests for each CI transition from review-pending: pending, fail, pass, merge conflict
- Add full multi-round cycle test: request-changes -> ci-pending -> ci-passed -> reviewing -> approve -> merge
- Verify existing handleReviewing tests still pass (no regressions)
- Edge case: ciStatus undefined in snapshot (should no-op, stay in review-pending)

Acceptance: Items in `review-pending` detect CI changes and re-enter the review cycle. `bun test test/` passes. Full multi-round cycle verified in unit tests.

Key files: `core/orchestrator.ts:1073`, `test/orchestrator-unit.test.ts`
