# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## CLI Migration (TypeScript migration completion, 2026-03-23)


### Refactor: Remove legacy bash script and test infrastructure (H-MIG-3)

**Priority:** High
**Source:** Migration plan 2026-03-23
**Depends on:** H-MIG-1, H-MIG-2

Delete `core/batch-todos.sh` (2243 lines). Delete bash test files: `test/test_batch_order.sh`, `test/test_mark_done.sh`, `test/test_parse_todos.sh`, `test/test_version_bump.sh`, `test/test_cross_repo.sh`, `test/helpers.sh`, `test/run_all.sh`. Remove or simplify `test/parity.test.ts` (currently skipped). Remove `NINTHWAVE_LEGACY` branch from the shim template in `setup` (make it always use bun). Also remove the legacy branch from `.ninthwave/work`.

Acceptance: `bun test` passes. No references to `batch-todos.sh` in any `.ts` file. `setup` generates a bun-only shim. `core/batch-todos.sh` no longer exists.

Key files: `core/batch-todos.sh`, `test/test_batch_order.sh`, `test/test_mark_done.sh`, `test/test_parse_todos.sh`, `test/test_version_bump.sh`, `test/test_cross_repo.sh`, `test/helpers.sh`, `test/run_all.sh`, `test/parity.test.ts`, `setup`, `.ninthwave/work`

---

### Docs: Update documentation to reflect TypeScript CLI (M-MIG-4)

**Priority:** Medium
**Source:** Migration plan 2026-03-23
**Depends on:** H-MIG-3

Update all documentation that still references `batch-todos.sh`. In `CONTRIBUTING.md`: replace `batch-todos.sh` in architecture tree with `cli.ts` + `commands/` directory, update key files table, update "How the Pieces Fit" step 3. In `README.md`: remove legacy references on lines 255 and 262. In `core/docs/todos-format.md`: change `batch-todos.sh` references on lines 28 and 125 to `core/parser.ts` / "the ninthwave CLI". Leave `CHANGELOG.md` unchanged (historical record).

Acceptance: No remaining references to `batch-todos.sh` in any `.md` file except `CHANGELOG.md`.

Key files: `CONTRIBUTING.md`, `README.md`, `core/docs/todos-format.md`

---

### Test: Add tests for start, clean, watch, and ci commands (M-MIG-5)

**Priority:** Medium
**Source:** Migration plan 2026-03-23
**Depends on:** H-MIG-1

Add unit tests for commands that currently lack test coverage. Use `vi.mock` to mock external dependencies (`git.ts`, `gh.ts`, `cmux.ts`, `partitions.ts`). Test `detectAiTool()` environment variable detection paths. Test argument validation for `cmdStart`, `cmdClean`, `cmdCleanSingle`, `cmdCloseWorkspace`. Test `cmdWatchReady` status classification (merged/ready/pending/failing/no-pr). Test `cmdCiFailures` with failures and without. Test `cmdCloseWorkspaces`/`cmdCloseWorkspace` with mocked cmux. For async commands (`cmdAutopilotWatch`, `cmdPrWatch`), test initial state and transition detection.

Acceptance: `bun test` passes with new test files included. Each command has at least argument validation + one happy-path test.

Key files: `test/start.test.ts`, `test/clean.test.ts`, `test/watch.test.ts`, `test/ci.test.ts`, `core/commands/start.ts`, `core/commands/clean.ts`, `core/commands/watch.ts`, `core/commands/ci.ts`

---
