# Refactor: Drop create-todo GitHub Action and update VISION.md (H-VF-2)

**Priority:** High
**Source:** Scope reduction plan 2026-03-28
**Depends on:** H-RN-2
**Domain:** verify

Remove the `actions/create-todo/` GitHub Action directory entirely. The daemon now handles post-merge CI failures directly via the verification state machine (H-VF-1), making this action redundant.

Delete the entire `actions/create-todo/` directory including: `action.yml`, `index.ts`, `lib.ts`, `dist/index.js`, and any other files.

Remove any references to the create-todo action from docs: check README.md, CONTRIBUTING.md, ARCHITECTURE.md. Remove the `test/create-todo-action.test.ts` test file if it exists.

Update VISION.md line 110: the "Not a monitoring system" entry currently says "Work items come from `.ninthwave/todos/` files or the `create-todo` GitHub Action." Update to reflect that post-merge CI verification is orchestration (completing the change lifecycle on GitHub), not monitoring. Remove the create-todo action reference. Also update item 5 which references `.ninthwave/todos/` -- change to `.ninthwave/work/` (should already be renamed by H-RN-1).

**Test plan:**
- Verify `ls actions/create-todo/` fails (directory deleted)
- Verify `grep -r "create-todo" .` returns zero hits (except CHANGELOG)
- Run `bun test test/` -- verify no test references the deleted action
- Manual review: VISION.md "Not These Things" section accurately describes post-merge verification as orchestration

Acceptance: `actions/create-todo/` directory deleted. Zero references to create-todo action (except CHANGELOG). VISION.md updated to describe post-merge verification as orchestration, not monitoring. All tests pass.

Key files: `actions/create-todo/`, `VISION.md:110`, `test/create-todo-action.test.ts`
