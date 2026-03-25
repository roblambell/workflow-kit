# Feat: Stack comment integration into orchestrator (M-STK-6)

**Priority:** Medium
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** H-STK-5, H-STK-2
**Domain:** branch-stacking

Wire `syncStackComments()` from `core/stack-comments.ts` into the orchestrator lifecycle so stack navigation comments are automatically posted and updated on PRs.

Add `syncStackComments` to `OrchestratorDeps` (injectable for testing). Add `buildStackChain(item)` helper method to the orchestrator that walks the dependency graph to build the ordered stack array (`[{id, prNumber, title}]`).

Comment lifecycle:
1. When a stacked item's PR is first detected (transition to `pr-open` with `baseBranch` set): build the stack chain and call `syncStackComments()` on all PRs in the chain
2. When a dep merges (`executeMerge` for stacked items): rebuild the stack chain (excluding the merged item) and update comments on remaining PRs
3. When the last stacked item merges: remove stack comments (or leave them as historical)

**Test plan:**
- Test `buildStackChain()`: given items A→B (B depends on A), verify produces `[A, B]` with correct PR numbers
- Test PR-open trigger: when stacked item transitions to pr-open, verify `syncStackComments` is called with the correct stack
- Test post-merge update: after dep merges, verify `syncStackComments` is called with updated stack (merged item removed)

Acceptance: Stacked PRs automatically receive navigation comments showing the full stack tree. Comments update when PRs in the stack merge. Non-stacked PRs are unaffected. `syncStackComments` is injected (not imported) for test isolation.

Key files: `core/orchestrator.ts`, `core/stack-comments.ts`, `test/orchestrator.test.ts`
