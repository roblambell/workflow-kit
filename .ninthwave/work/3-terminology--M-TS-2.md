# Refactor: Rename WIP to session in test files (M-TS-2)

**Priority:** Medium
**Source:** Terminology alignment -- v0.4.0 renamed public API but test descriptions and comments were not migrated
**Depends on:** None
**Domain:** terminology

**Lineage:** 00c8f979-85e1-4bfc-beae-f5ed7906d9aa

Rename all remaining "WIP" references to "session" in test/*.ts files. This includes test description strings (it/describe), code comments, and section header comments. Same replacement patterns as M-TS-1. Mechanical rename only -- no behavioral or assertion changes.

The bulk of changes are in test/orchestrator.test.ts (~36 refs) and test/orchestrator-unit.test.ts (~8 refs). Other test files have 1-6 refs each.

**Test plan:**
- Run `bun run test` -- renamed test descriptions must not break test filters or snapshot expectations
- Grep for remaining "WIP" in test/*.ts after changes to confirm none were missed
- Verify no assertion logic was accidentally modified

Acceptance: Zero "WIP" references remain in test/*.ts files. All tests pass. No behavioral or assertion changes.

Key files: `test/orchestrator.test.ts`, `test/orchestrator-unit.test.ts`, `test/orchestrate.test.ts`, `test/daemon-integration.test.ts`, `test/schedule-runner.test.ts`, `test/schedule-history.test.ts`, `test/tui-keyboard.test.ts`, `test/tui-widgets.test.ts`, `test/interactive.test.ts`, `test/external-review.test.ts`, `test/onboard.test.ts`, `test/status.test.ts`, `test/status-render.test.ts`, `test/scenario/stacking.test.ts`, `test/system/watch-runtime-controls.test.ts`
