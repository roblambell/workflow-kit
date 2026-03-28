# Refactor: Remove reviewEnabled, AI review always-on (H-MS-2)

**Priority:** High
**Source:** Friction decomposition 2026-03-28, replacing H-TUI-3
**Depends on:** H-MS-1
**Domain:** cli-ux

Remove the `reviewEnabled` boolean from `OrchestratorConfig`. AI review is always on -- the review gate in `evaluateMerge()` becomes unconditional. This simplifies the config and ensures every PR gets reviewed.

Changes:
1. Remove `reviewEnabled: boolean` from `OrchestratorConfig` interface (orchestrator.ts:106-129)
2. Remove `reviewEnabled` from `DEFAULT_CONFIG` (orchestrator.ts:368)
3. In `evaluateMerge()`: remove the `if (this.config.reviewEnabled && ...)` guard. The review gate (`if (!item.reviewCompleted)`) runs unconditionally.
4. Remove `--review` / `--no-review` CLI flags from `parseWatchArgs()` if they exist
5. Remove `reviewEnabled` from interactive prompt if it's a user-facing option
6. Update all tests that set `reviewEnabled: false` -- remove the field, verify review always runs
7. Update all tests that set `reviewEnabled: true` -- remove the field, behavior unchanged

**Test plan:**
- Test evaluateMerge: review gate fires for all strategies without needing reviewEnabled
- Test that OrchestratorConfig no longer accepts reviewEnabled field
- Test existing review flow (ci-passed -> reviewing -> review-passed -> merge) still works
- Verify no test files reference reviewEnabled after cleanup

Acceptance: `reviewEnabled` field does not exist on OrchestratorConfig. AI review runs for every PR regardless of strategy. Review gate in evaluateMerge is unconditional. `bun test test/` passes.

Key files: `core/orchestrator.ts:106-129,368,1316-1339`, `core/commands/orchestrate.ts`, `test/orchestrator-unit.test.ts`, `test/orchestrator.test.ts`
