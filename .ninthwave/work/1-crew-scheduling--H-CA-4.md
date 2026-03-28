# Feat: Dependency-aware claims with author-based affinity (H-CA-4)

**Priority:** High
**Source:** Creator affinity scheduling refinement (2026-03-28)
**Depends on:** H-CA-1, H-CA-2
**Domain:** crew-scheduling

Update the broker claim handler to implement the full scheduling model. Two changes: (1) Dependency filtering -- before sorting, filter out items whose dependencies are not all resolved. A dependency is resolved when its ID exists in the broker's todos map with `completedBy !== null`. Items with unresolved dependencies must not be claimable regardless of who requests them. (2) Author-based affinity -- replace the current `creatorDaemonId === daemonId` sort with author-operator matching. Look up the requesting daemon's `operatorId` (from DaemonState) and compare against each item's `author` field (from TodoEntry). Same sort order: author affinity first, then priority (lower = higher), then oldest first. Log affinity as `"author"` or `"pool"` (replacing `"creator"`). Review jobs already bypass crew claims entirely (they are local-only in the orchestrator), so no special handling is needed.

**Test plan:**
- Test dependency filtering: item B depends on A, A not completed -- B should not be claimable
- Test dependency resolution: complete A, then B becomes claimable
- Test author affinity: daemon with operatorId "rob@example.com" prefers items authored by "rob@example.com"
- Test pool fallback: when no author-matched items exist, daemon gets highest-priority unclaimed item
- Test combined: dependency filtering + author affinity work together (author items with unresolved deps still filtered)
- Edge case: circular dependencies (A depends on B, B depends on A) -- neither should be claimable
- Edge case: dependency on an item not in the broker's todos map -- treat as unresolved

Acceptance: `handleClaimRequest` filters out items with unresolved dependencies before sorting. Affinity sort matches `todo.author` against `daemon.operatorId` instead of `creatorDaemonId`. Affinity events log `"author"` or `"pool"`. All existing mock-broker tests updated to use the new model. New tests cover dependency filtering and author matching.

Key files: `core/mock-broker.ts:368-400`, `core/mock-broker.ts:30-37`, `test/mock-broker.test.ts`
