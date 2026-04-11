# Fix: Silent inbox delivery failures for CI and PR comments (H-WR-2)

**Priority:** High
**Source:** Dogfooding friction -- workers idle waiting for notifications that never arrive
**Depends on:** None
**Domain:** worktree-reliability
**Lineage:** dcaae855-8c56-406c-8845-71590967f54c

Two inbox delivery bugs cause workers to miss critical notifications. First, `executeNotifyCiFailure()` returns `{ success: true }` when no worktree target exists -- the CI failure notification is never written but the action reports success, masking the delivery failure. Fix: return `{ success: false }` with a clear reason so the orchestrator can handle retry/escalation honestly. Second, `processComments()` returns `[]` when `!item.workspaceRef`, silently dropping all PR comment relay actions. After a retry clears `workspaceRef`, comments posted during the gap are never delivered. Fix: attempt inbox file write via `resolveImplementerInboxTarget()` (worktree path resolution) even without a live `workspaceRef`, since the worktree directory may still exist on disk.

**Test plan:**
- Unit test: `executeNotifyCiFailure` returns `{ success: false }` when `resolveImplementerInboxTarget` finds no worktree
- Unit test: `processComments` attempts comment relay when `workspaceRef` is undefined but worktree path exists on disk
- Unit test: `processComments` still returns `[]` for items with no worktree path at all (no crash)
- Verify existing orchestrator CI-failure and comment-relay tests still pass

Acceptance: `executeNotifyCiFailure()` returns `{ success: false }` when inbox target is missing. `processComments()` does not gate on `workspaceRef` alone -- it attempts delivery via worktree path resolution. Workers receive CI failure and PR comment notifications even after session retry clears `workspaceRef`. All existing orchestrator tests pass.

Key files: `core/orchestrator-actions.ts`, `core/orchestrator.ts`
