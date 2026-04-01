# Fix: Remove merged work items during merge completion (H-SRP-4)

**Priority:** High
**Source:** Manual request 2026-04-01 -- stale replay prevention with reused-ID safety
**Depends on:** H-SRP-1, H-SRP-3
**Domain:** orchestrator-reliability

Move merged-item removal closer to the successful merge path so completed work does not depend only on a later `reconcile` pass to disappear from `.ninthwave/work/`. When a PR merges successfully, the orchestrator should remove or mark done the matching work-item file using lineage-token-aware identity checks, then persist that deletion so future startups do not re-read stale work from remote state.

**Test plan:**
- Add post-merge coverage in `test/orchestrate.test.ts` proving the matching work-item file is removed after merge success and not replayed on a later restart
- Verify a reused-ID item with a different lineage token is preserved even if an older PR on the same ID just merged
- Verify merge-path cleanup failure modes remain visible and do not silently delete the wrong work-item file

Acceptance: Successful orchestrator merges remove or mark done the correct work-item file as part of merge completion, and future startups do not replay that item from remote work-file state. Reused-ID items with a different lineage token are not accidentally deleted.

Key files: `core/orchestrator-actions.ts`, `core/commands/orchestrate.ts`, `core/commands/reconcile.ts`, `test/orchestrate.test.ts`, `test/work-item-id-collision.test.ts`
