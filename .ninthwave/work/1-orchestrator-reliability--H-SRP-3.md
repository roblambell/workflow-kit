# Fix: Make status and cleanup token-aware (H-SRP-3)

**Priority:** High
**Source:** Manual request 2026-04-01 -- stale replay prevention with reused-ID safety
**Depends on:** H-SRP-1
**Domain:** orchestrator-reliability

Apply lineage-token-aware merged detection to the command paths that still over-trust `merged` status for a reused ID: `status`, `clean`, `mark-done`, and `reconcile`. These commands should use the same branch-based candidate lookup they use today, but only treat a merged PR as belonging to the current work item when the lineage token matches, with a deliberate fallback for legacy token-less items.

**Test plan:**
- Add command-level coverage showing reused IDs with an older merged PR do not report as merged when the lineage token does not match
- Verify `status`, `clean`, and `mark-done` preserve current behavior for normal non-reused items and legacy token-less items
- Extend reconcile coverage so merged-item deletion skips token mismatches and only removes the matching logical item

Acceptance: `status`, `clean`, `mark-done`, and `reconcile` no longer confuse a newer reused-ID item with an older merged PR when lineage tokens differ. Existing non-reused and legacy token-less flows continue to behave correctly.

Key files: `core/commands/status.ts`, `core/commands/clean.ts`, `core/commands/mark-done.ts`, `core/commands/reconcile.ts`, `test/work-item-id-collision.test.ts`, `test/merge-detection.test.ts`
