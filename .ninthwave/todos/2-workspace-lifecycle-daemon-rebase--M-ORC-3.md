# Fix: Emit clean action when items transition to stuck (M-ORC-3)

**Priority:** Medium
**Source:** Friction #23 — orphaned workspaces after stuck items
**Depends on:** None
**Domain:** workspace-lifecycle-daemon-rebase

`stuckOrRetry()` returns `[]` when an item is permanently stuck — no clean action, so the workspace and worktree are never cleaned up. Same gap in the ci-failed -> stuck path in `handlePrLifecycle`.

Return `[{ type: "clean", itemId: item.id }]` instead of `[]` in both stuck paths. `executeClean` already handles workspace closure + worktree cleanup correctly.

**Test plan:**
- Update existing stuck transition tests to expect a `"clean"` action
- Verify ci-failed -> stuck (max retries exceeded) also emits clean action
- Verify heartbeat timeout -> stuck emits clean action

Acceptance: All stuck transitions emit a clean action. Existing tests updated. `bun test test/` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
