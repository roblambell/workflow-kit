# Fix: Use lineage tokens to block startup replay (H-SRP-2)

**Priority:** High
**Source:** Manual request 2026-04-01 -- stale replay prevention with reused-ID safety
**Depends on:** H-SRP-1
**Domain:** orchestrator-reliability

Change startup and recovery so a merged item with a lingering `.ninthwave/work/*.md` file is pruned before it can be queued again. Candidate merged PRs should still be discovered by `headRefName` for `ninthwave/<id>`, but the final identity check should use the lineage token when present, with a clearly bounded fallback path for legacy token-less items.

**Test plan:**
- Add restart/startup coverage in `test/orchestrate.test.ts` proving a merged item with a lingering work file is not re-queued on daemon startup
- Cover the reused-ID case where the old merged PR and the new work item share an ID but have different lineage tokens, and verify the new item is not pruned
- Verify open or unmerged items still load normally, and legacy token-less items continue through the fallback path without crashing recovery

Acceptance: Startup and recovery no longer replay a merged item solely because its work-item file still exists. Reused IDs are distinguished by lineage token when available, and legacy items continue to function through an explicit compatibility path.

Key files: `core/commands/orchestrate.ts`, `core/reconstruct.ts`, `core/snapshot.ts`, `core/commands/pr-monitor.ts`, `test/orchestrate.test.ts`, `test/work-item-id-collision.test.ts`
