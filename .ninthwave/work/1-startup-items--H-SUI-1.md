# Refactor: Split startup item loading into local-first and remote refresh phases (H-SUI-1)

**Priority:** High
**Source:** Spec `.opencode/plans/1775113783118-mighty-squid.md`
**Depends on:** None
**Domain:** startup-items
**Lineage:** 118fe731-62c3-4148-b019-aac6dc7dcdbc

Refactor `core/startup-items.ts` so startup item loading no longer hard-codes GitHub polling into the first read. Keep the current merged-PR pruning and metadata-match behavior exactly intact, but expose a local-only loader plus an async refresh path that returns enough information to diff item IDs and explain what changed after first paint.

**Test plan:**
- Extend `test/orchestrate.test.ts` coverage around `pruneMergedStartupReplayItems(...)` so merged-vs-unmerged and metadata-match behavior stays identical after the refactor
- Add or update tests for the new local-only loader to verify it returns parsed runnable items without invoking PR polling
- Add coverage for the refresh helper's diff output so callers can detect removed item IDs and preserve still-valid selections

Acceptance: Startup item loading supports a first-pass local read with no GitHub polling, plus a follow-up refresh that preserves the existing merged replay pruning semantics and exposes deterministic item-diff data for UI callers.

Key files: `core/startup-items.ts`, `test/orchestrate.test.ts`, `test/onboard.test.ts`
