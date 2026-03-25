# Test: Add unit tests for executeRebase action handler (M-TST-2)

**Priority:** Medium
**Source:** Eng review H-ENG-1 — finding F13
**Depends on:** None
**Domain:** orchestrator-review-findings

The `executeRebase` method in `core/orchestrator.ts` has no direct unit tests. It handles rebase message delivery to workers and is a critical recovery mechanism. Add tests covering: successful message send, failure when workspaceRef is missing, failure when `sendMessage` returns false.

**Test plan:**
- Unit test: executeRebase sends message to workspace and returns success
- Unit test: executeRebase returns error when workspaceRef is undefined
- Unit test: executeRebase returns error when sendMessage returns false
- Unit test: executeRebase uses action.message when provided, falls back to default

Acceptance: All four `executeRebase` paths are covered by unit tests. Tests pass.

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`
