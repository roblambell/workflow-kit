# Feat: Enrich sync protocol with dependency and priority metadata (H-CA-1)

**Priority:** High
**Source:** Creator affinity scheduling refinement (2026-03-28)
**Depends on:** None
**Domain:** crew-scheduling

The SyncMessage currently sends `activeTodoIds: string[]` -- a flat list of TODO IDs with no metadata. The broker hardcodes `priority: 1` for all synced items and has no dependency information. Enrich the sync protocol so each item includes its dependencies, priority, and author. Update TodoEntry to store these fields and handleSync to populate them from sync data. The enriched data enables dependency-aware claim filtering and author-based affinity matching in H-CA-4.

**Test plan:**
- Update existing mock-broker sync tests to send enriched item metadata and verify TodoEntry stores deps, priority, and author correctly
- Add test: re-sync with updated priority/deps updates the existing TodoEntry (idempotent upsert, not insert-only)
- Add test: sync with empty dependencies array stores `[]`, not undefined
- Verify existing crew.test.ts client tests still pass with the new SyncMessage shape

Acceptance: SyncMessage sends `items: { id: string; dependencies: string[]; priority: number; author: string }[]` instead of `activeTodoIds: string[]`. TodoEntry includes `dependencies: string[]` and `author: string` fields. handleSync stores real priority and dependency data from sync payloads. All existing broker and crew client tests pass.

Key files: `core/crew.ts:15-19`, `core/mock-broker.ts:30-37`, `core/mock-broker.ts:347-366`, `core/commands/orchestrate.ts:1478-1486`, `test/mock-broker.test.ts`
