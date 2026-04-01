# Fix: Re-enter the canonical item into PR flow after post-merge repair starts (H-PMR-1)

**Priority:** High
**Source:** Decomposed from post-merge CI repair tracking feature 2026-04-01
**Depends on:** None
**Domain:** post-merge-repair-tracking

Change the post-merge fix-forward state machine so the original work item remains the only canonical item while a repair moves it back into an active, investigating-style lifecycle instead of looking merged or done. When a forward-fixer creates a repair PR, the orchestrator must treat that PR as the new active PR for the same item and drive it back through the normal CI, review, and merge states. Keep the implementation minimal by preserving one active PR on the item plus enough prior PR history and merge context to support full re-entry, instead of introducing a generalized prs[] model unless the existing code clearly forces it.

**Test plan:**
- Extend `test/verify-main.test.ts` with end-to-end coverage for merged -> forward-fix-pending -> fix-forward-failed -> fixing-forward -> repair PR opened -> ci-pending/review/merged -> post-merge verification complete on the canonical item
- Add coverage for both repair outcomes: a minimal forward fix PR and a revert PR, proving both are accepted as first-class re-entry paths
- Verify dependency gating does not unblock downstream work until the canonical item finishes its final post-repair verification

Acceptance: Once post-merge CI fails, the canonical item no longer looks complete. If a forward-fixer opens either a repair PR or a revert PR, that same item re-enters the normal PR lifecycle with the repair PR as its active PR and only transitions to `done` after the repair merge has itself passed post-merge verification.

Key files: `core/orchestrator.ts`, `core/orchestrator-types.ts`, `core/snapshot.ts`, `test/verify-main.test.ts`
